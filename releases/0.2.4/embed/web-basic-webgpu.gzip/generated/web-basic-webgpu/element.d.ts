// Generated from catalog.json and element.json; do not edit.
import type { AnsweredFor, CallOptions, Capabilities, CinemaViewer, CommandName, CommandReply, Commands, ErrorCode, EventName, EventRecord, JsonValue, Transport, Warning } from './client';
export type { AnsweredFor, CallOptions, CommandName, CommandReply, Commands, EventName, EventRecord, Transport };
export type CinemaViewerReadyDetail = null;
export type CinemaViewerWarningDetail = (Warning);
export type CinemaViewerFailedDetail = { readonly "code": ErrorCode; readonly "message": string; readonly "reason": string; };
export type CinemaViewerContextmenuDetail = { readonly "alt": boolean; readonly "ctrl": boolean; readonly "meta": boolean; readonly "shift": boolean; readonly "x": number; readonly "y": number; };
export interface CinemaViewerElementEventMap extends HTMLElementEventMap {
  "model-dropped": CustomEvent<EventRecord<"model.dropped">>;
  "model-load-failed": CustomEvent<EventRecord<"model.load_failed">>;
  "model-loaded": CustomEvent<EventRecord<"model.loaded">>;
  "render-failed": CustomEvent<EventRecord<"render.failed">>;
  "render-lost": CustomEvent<EventRecord<"render.lost">>;
  "render-restored": CustomEvent<EventRecord<"render.restored">>;
  "viewer-camera-changed": CustomEvent<EventRecord<"viewer.camera_changed">>;
  "cinema-viewer-ready": CustomEvent<CinemaViewerReadyDetail>;
  "cinema-viewer-warning": CustomEvent<CinemaViewerWarningDetail>;
  "cinema-viewer-failed": CustomEvent<CinemaViewerFailedDetail>;
  "cinema-viewer-contextmenu": CustomEvent<CinemaViewerContextmenuDetail>;
}
export interface CinemaViewerElement extends HTMLElement, CinemaViewer {
  readonly ready: Promise<null>;
  readonly capabilities: (null) | (Capabilities);
  readonly diagnostics: (null) | ({ readonly "adapter"?: (null) | ({ readonly "backend": "noop" | "vulkan" | "metal" | "dx12" | "gl" | "browser_webgpu"; readonly "device_type": "other" | "integrated_gpu" | "discrete_gpu" | "virtual_gpu" | "cpu"; readonly "driver_info": string; readonly "is_fallback_adapter"?: boolean; readonly "name": string; readonly "vendor_id": number; }); readonly "code"?: ErrorCode; readonly "details"?: JsonValue; readonly "hint"?: string; readonly "path"?: string; readonly "warnings"?: readonly (Warning)[]; readonly "warnings_dropped"?: number; });
  readonly recoveryWarnings: readonly (Warning)[];
  assetBase: string;
  contextMenu: "camera" | "browser";
  addEventListener<K extends keyof CinemaViewerElementEventMap>(type: K, listener: (this: CinemaViewerElement, ev: CinemaViewerElementEventMap[K]) => unknown, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof CinemaViewerElementEventMap>(type: K, listener: (this: CinemaViewerElement, ev: CinemaViewerElementEventMap[K]) => unknown, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}
declare global { interface HTMLElementTagNameMap { "cinema-viewer": CinemaViewerElement } }
export declare function defineCinemaViewer(): void;
