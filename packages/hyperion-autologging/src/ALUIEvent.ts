/**
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

'use strict';
import type * as Types from "hyperion-util/src/Types";
import { ALElementEvent, ALExtensibleEvent, ALFlowletEvent, ALLoggableEvent, ALMetadataEvent, ALPageEvent, ALReactElementEvent, ALTimedEvent } from "./ALType";
import { ALElementTextEvent } from "./ALInteractableDOMElement";
import { ALSurfaceEvent } from "./ALSurfaceData";

export type CommonEventData = (ALUIEvent & ALTimedEvent & ALPageEvent) & {
  // The event.target element,  as opposed to element which represents the interactableElement
  targetElement: Element | null;
  value?: string;
};


export type EventHandlerMap = DocumentEventMap;

export type UIEventConfigMap = {
  [K in keyof EventHandlerMap]: Readonly<{
    eventName: K,
    // A callable filter for this event, returning true if the event should be emitted, or false if it should be discarded up front
    eventFilter?: (domEvent: EventHandlerMap[K]) => boolean;
    // Whether to limit to elements that are "interactable", i.e. those that have event handlers registered to the element.  Defaults to true.
    interactableElementsOnly?: boolean;
    // Whether to cache element's react information on capture, defaults to false.
    cacheElementReactInfo?: boolean;
    /**
    * Some events may trigger a change in the UI, which means using cached text is not safe.
    * We always update the cache after text extraction (if cache is enabled), it is only safe
    * to use the cached value (and skip recomputation) for certain events (e.g. mouseover).
    * This field allows controlling this behavior. It is on by default for all events except /click|change|input|key/
    */
    useCachedElementText?: boolean;
    /**
     * Whether to include elementName, and elementText extraction and fields in the published events.
     * Element text extraction can be expensive depending on the event,  and may not be needed in some cases.
     * Defaults to false behavior.
     */
    enableElementTextExtraction?: boolean;
  }>
};

/**
 * Generates a union type of all handler event and domEvent permutations.
 * e.g. {domEvent: KeyboardEvent, event: 'keydown', ...}
 */
type ALUIEventMap = {
  [K in keyof EventHandlerMap]: Readonly<{
    // The typed domEvent associated with the event we are capturing
    domEvent: EventHandlerMap[K],
    // Event we are capturing
    event: K,
    // Whether the event is generated from a user action or dispatched via script
    isTrusted: boolean,
  }>
};


export type ALUIEvent =
  ALExtensibleEvent &
  ALMetadataEvent &
  ALPageEvent &
  ALTimedEvent &
  Types.Nullable<ALElementEvent> &
  {
    /**
     * .element field could be either target associated with the domEvent; With interactableElementsOnly, the interactable element target.
     * .targetElement is the event.target element, as opposed to .element which could represent the interactableElement
     */
    targetElement: Element | null,
  } &
  // Extend ALUIEvents with `hover` and other derived events
  (
    ALUIEventMap[keyof ALUIEventMap] |
    Omit<ALUIEventMap['mouseover'], 'event'> & { event: 'hover' }
  );
;

export type ALUIEventCaptureData = Readonly<
  ALElementTextEvent &
  ALFlowletEvent &
  ALReactElementEvent &
  ALUIEvent &
  CommonEventData &
  Types.Nullable<ALSurfaceEvent> &
  {
    // surface: string | null;
    value?: string;
  }
>;

export type ALUIEventBubbleData = Readonly<
  ALUIEvent
>;

export type ALLoggableUIEvent = Readonly<
  ALUIEventCaptureData &
  ALLoggableEvent
>;

export type ALUIEventData = Readonly<
  ALLoggableUIEvent
>;

export type ALChannelUIEvent = Readonly<{
  al_ui_event_capture: [ALUIEventCaptureData],
  al_ui_event_bubble: [ALUIEventBubbleData],
  al_ui_event: [ALUIEventData],
}>;

// Extend UIEventConfig with additional event-specific configuration
export type UIEventConfig = UIEventConfigMap[keyof Omit<EventHandlerMap, 'change' | 'mouseover'>]
  | (
    UIEventConfigMap['change'] & {
      // (Default: true) Whether to include default state of radio/input/select elements when surfaces are mounted.
      includeInitialDefaultState?: boolean,
      // (Default: false) When includeInitialDefaultState is enabled, whether to also emit disabled state for input[checked] = false.  Otherwise only enabled state will be emitted.
      includeInitialDefaultDisabledState?: boolean
    }
  )
  | (
    UIEventConfigMap['mouseover'] & {
      // The duration in ms required for hovering over an element to emit a standalone `hover` event
      durationThresholdToEmitHoverEvent?: number;
    }
  );
