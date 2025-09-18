/**
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

'use strict';
import type * as Types from "hyperion-util/src/Types";

import { intercept } from "hyperion-core/src/intercept";
import * as IEvent from "hyperion-dom/src/IEvent";
import { setTriggerFlowlet } from "hyperion-flowlet/src/TriggerFlowlet";
import { TimedTrigger } from "hyperion-timed-trigger/src/TimedTrigger";
import performanceAbsoluteNow from "hyperion-util/src/performanceAbsoluteNow";
import ALElementInfo from './ALElementInfo';
import * as ALEventIndex from "./ALEventIndex";
import { ALID, getOrSetAutoLoggingID } from "./ALID";
import { TrackEventHandlerConfig, enableUIEventHandlers, getElementTextEvent, getInteractable, isTrackedEvent } from "./ALInteractableDOMElement";
import { ReactComponentData } from "./ALReactUtils";
import { getSurfacePath } from "./ALSurfaceUtils";
import { ALSharedInitOptions, Metadata } from "./ALType";
import * as ALUIEventGroupPublisher from "./ALUIEventGroupPublisher";
import * as Flags from "hyperion-globals/src/Flags";
import { getCurrMainPageUrl } from "./MainPageUrl";
import { ALSurfaceData } from "./ALSurfaceData";
import { ALChannelUIEvent, ALUIEventCaptureData, ALUIEventData, CommonEventData, UIEventConfig } from "./ALUIEvent";


const MAX_CAPTURE_TO_BUBBLE_DELAY_MS = 500;

type CurrentUIEvent = {
  data: ALUIEventData,
  timedEmitter: TimedTrigger,
};




export type InitOptions = Types.Options<
  ALSharedInitOptions<ALChannelUIEvent> &
  {
    uiEvents: Array<UIEventConfig>;
  }
>;

// Entrypoint to set up tracking and enable handlers
export function trackAndEnableUIEventHandlers(eventName: UIEventConfig['eventName'], eventHandlerConfig: Omit<TrackEventHandlerConfig, 'active'>): void {
  enableUIEventHandlers(eventName, eventHandlerConfig);
}

function getCommonEventData<T extends keyof DocumentEventMap>(eventConfig: UIEventConfig, eventName: T, event: DocumentEventMap[T]): CommonEventData | null {
  const eventTimestamp = performanceAbsoluteNow();

  const { eventFilter, interactableElementsOnly = true } = eventConfig;

  if (eventFilter && !eventFilter(event as any)) {
    return null;
  }

  let element: Element | null = null;
  let autoLoggingID: ALID | null = null;
  if (interactableElementsOnly) {
    /**
     * Because of how UI events work in browser, one could for example click anywhere
     * on a sub-tree an element and the event handler of that element will handle the event
     * once the event "bublles" to it.
     * For interactable elements, first we walk as high up the DOM tree as we can
     * to find the actuall element on which the original event handler was added.
     * We use that as the base of event to ensure the text, surface, ... for events
     * remain consistent no matter where the user actually clicked, hovered, ...
     */
    element = getInteractable(event.target, eventName);
    if (element == null) {
      return null;
    }
    autoLoggingID = getOrSetAutoLoggingID(element);
  }
  else {
    element = event.target instanceof Element ? event.target : null;
  }

  let value: string | undefined;
  const metadata: Metadata = {};
  if (eventName === 'change' && element) {
    switch (element.nodeName) {
      case 'INPUT': {
        const input = element as HTMLInputElement;
        value = input.checked + '';
        metadata.type = input.getAttribute('type') ?? '';
        break;
      }
      case 'SELECT': {
        const select = element as HTMLSelectElement;
        value = select.value;
        metadata.type = 'select';
        metadata.text = select.options[select.selectedIndex].text;
        break;
      }
    }
  }

  return {
    domEvent: event,
    event: (eventName as any),
    element,
    targetElement: event.target instanceof Element ? event.target : null,
    eventTimestamp,
    isTrusted: event.isTrusted,
    autoLoggingID,
    metadata,
    value,
    pageURI: getCurrMainPageUrl(),
  };
}

let lastUIEvent: CurrentUIEvent | null;
export function getCurrentUIEventData(): ALUIEventData | null | undefined {
  return lastUIEvent?.data;
}

/**
 *
 * @param options - Configuration for determining which events to capture and emit events via provided channel.
 * This function adds listeners for events via {@link window.document.addEventListener} (both capture and bubble phases),  and enriches these
 * events with multiple attributes, including react information.  Capturing of information
 * and filtering of events is configured via {@link UIEventConfig}.
 */
export function publish(options: InitOptions): void {
  const { uiEvents, flowletManager, channel } = options;


  uiEvents.forEach((eventConfig => {
    const {
      eventName,
      cacheElementReactInfo = false,
      useCachedElementText = !/click|change|input|key/.test(eventName), // by default we skipt cache for these value
      enableElementTextExtraction = false,
    } = eventConfig;


    // the following will ensure that repeated items in the list won't have double handlers
    if (isTrackedEvent(eventName)) {
      // Already handled
      return;
    }

    // Track event in the capturing phase
    const captureHandler = (event: Event): void => {
      const uiEventData = getCommonEventData(eventConfig, eventName, event);
      if (!uiEventData) {
        return;
      }
      const { element, targetElement, autoLoggingID } = uiEventData;

      const surface = getSurfacePath(targetElement);
      /**
       * Regardless of element, we want to set the flowlet on this event.
       * If we do have an element, we include its id in the flowlet.
       * Since it is possible to interact with the same exact element multiple times,
       * we need yet another distinguishing fact, for which we rely on flowlet id to be part of the name
       */
      let flowletName = eventName + `(`;
      let separator = '';
      let surfaceData: ALSurfaceData | null = null;
      if (surface) {
        flowletName += `${separator}surface=${surface}`;
        separator = '&';
        surfaceData = ALSurfaceData.get(surface);
        const eventMetadata = surfaceData?.getInheriteUIEventMetadata(eventName);
        if (eventMetadata) {
          Object.assign(uiEventData.metadata, eventMetadata);
        }
      }
      if (autoLoggingID) {
        flowletName += `${separator}element=${autoLoggingID}`;
      }
      flowletName += ')';

      let triggerFlowlet = new flowletManager.flowletCtor(flowletName, ALUIEventGroupPublisher.getGroupRootFlowlet(event));

      if (surface) {
        triggerFlowlet.data.surface = surface;
        triggerFlowlet.data.triggerUIEventName = eventName;
      }

      let callFlowlet = Flags.getFlags().preciseTriggerFlowlet
        ? flowletManager.top()
        : triggerFlowlet;

      let reactComponentData: ReactComponentData | null = null;
      if (targetElement && cacheElementReactInfo) {
        const elementInfo = ALElementInfo.getOrCreate(targetElement);
        reactComponentData = elementInfo.getReactComponentData();
      }
      let elementText = enableElementTextExtraction ? getElementTextEvent(element, surface, eventName, useCachedElementText) : getElementTextEvent(null, null);

      const eventData: ALUIEventCaptureData = {
        ...uiEventData,
        callFlowlet,
        triggerFlowlet,
        surface,
        surfaceData,
        ...elementText,
        reactComponentName: reactComponentData?.name,
        reactComponentStack: reactComponentData?.stack,
      };
      updateLastUIEvent(eventData);
      intercept(event); // making sure we can track changes to the Event object
      setTriggerFlowlet(event, triggerFlowlet); // now every event handler will push the right flowlet on the stack
      channel.emit('al_ui_event_capture', eventData);
    };

    /**
     * If any of the actual event handlers call stopPropagation, we know that
     * our bubble handler will not be called, so we trigger it rightaway
     */
    IEvent.stopPropagation.onBeforeCallObserverAdd(function (this) {
      if (lastUIEvent != null && lastUIEvent.data.domEvent === this) {
        lastUIEvent.data.metadata.propagation_was_stopped = "true";
        lastUIEvent.timedEmitter.run();
      }
    });

    // Track event in the bubbling phase
    const bubbleHandler = (event: Event): void => {
      const uiEventData = getCommonEventData(eventConfig, eventName, event);
      if (!uiEventData) {
        return;
      }

      channel.emit('al_ui_event_bubble', uiEventData);

      /**
       * We want the actual event fire after all bubble listeners are done
       * Therefore, we fire the second one here, instead of registering a
       * listener for the bubble events.
       */
      if (lastUIEvent != null) {
        const { data, timedEmitter } = lastUIEvent;
        if (data.event === eventName && data.domEvent.target === event.target) {
          /**
           * In case during al_ui_event_bubble subscribers have updated the
           * metadata of the event, we combine them into the metadata of the
           * al_ui_event_capture event.
           */
          Object.assign(data.metadata, uiEventData.metadata);
          timedEmitter.run();
        }
      }
    };

    // Enable the events handlers as well as interactable tracking
    trackAndEnableUIEventHandlers(eventName, {
      captureHandler,
      bubbleHandler,
    });
  }));

  function updateLastUIEvent(eventData: ALUIEventCaptureData) {
    if (lastUIEvent != null) {
      const { timedEmitter } = lastUIEvent;
      timedEmitter.run();
    }

    const data: ALUIEventData = {
      ...eventData,
      eventIndex: ALEventIndex.getNextEventIndex(),
    };

    lastUIEvent = {
      data,
      timedEmitter: new TimedTrigger(timerFired => {
        data.metadata.has_timed_out_before_bubble = '' + timerFired;
        channel.emit('al_ui_event', data);
        lastUIEvent = null;
      }, MAX_CAPTURE_TO_BUBBLE_DELAY_MS),
    };
  }
}
