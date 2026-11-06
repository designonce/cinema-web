// Generated from catalog.json and element.json; do not edit.
export const COMMANDS = Object.freeze([
  {name: "capture.render", receiver: "viewer", method: "capture", effect: "Capture"},
  {name: "diagnostics.graphics", receiver: "viewer", method: "getGraphics", effect: "Read"},
  {name: "events.read", receiver: "viewer", method: "readEvents", effect: "Read"},
  {name: "events.subscribe", receiver: "viewer", method: "subscribeEvents", effect: "Write"},
  {name: "events.unsubscribe", receiver: "viewer", method: "unsubscribeEvents", effect: "Write"},
  {name: "fog.get_scene_settings", receiver: "scene", method: "getSceneSettings", effect: "Read"},
  {name: "fog.set_scene", receiver: "scene", method: "setScene", effect: "Write"},
  {name: "fog.set_scene_settings", receiver: "scene", method: "setSceneSettings", effect: "Write"},
  {name: "fog.to_markup", receiver: "scene", method: "toMarkup", effect: "Read"},
  {name: "model.drop", receiver: "models", method: "drop", effect: "Write"},
  {name: "model.info", receiver: "models", method: "info", effect: "Read"},
  {name: "model.list", receiver: "models", method: "list", effect: "Read"},
  {name: "model.load", receiver: "models", method: "load", effect: "Write"},
  {name: "pick.at", receiver: "viewer", method: "pickAt", effect: "Read"},
  {name: "pick.hover", receiver: "viewer", method: "pickHover", effect: "Write"},
  {name: "pick.ray", receiver: "viewer", method: "pickRay", effect: "Read"},
  {name: "session.describe", receiver: "renderer", method: "describe", effect: "Read"},
  {name: "session.status", receiver: "renderer", method: "status", effect: "Read"},
  {name: "view.get_camera", receiver: "viewer", method: "getCamera", effect: "Read"},
  {name: "view.set_camera", receiver: "viewer", method: "setCamera", effect: "Write"},
  {name: "view.set_focus", receiver: "viewer", method: "setFocus", effect: "Write"},
  {name: "view.set_spin", receiver: "viewer", method: "setSpin", effect: "Write"},
  {name: "view.stop", receiver: "viewer", method: "stop", effect: "Write"},
  {name: "viewer.clear_selection", receiver: "viewer", method: "clearSelection", effect: "Write"},
  {name: "viewer.get_attributes", receiver: "viewer", method: "getAttributes", effect: "Read"},
  {name: "viewer.get_datums", receiver: "viewer", method: "getDatums", effect: "Read"},
  {name: "viewer.get_hover", receiver: "viewer", method: "getHover", effect: "Read"},
  {name: "viewer.get_selection", receiver: "viewer", method: "getSelection", effect: "Read"},
  {name: "viewer.resize", receiver: "viewer", method: "resize", effect: "Write"},
  {name: "viewer.set_attributes", receiver: "viewer", method: "setAttributes", effect: "Write"},
  {name: "viewer.set_datums", receiver: "viewer", method: "setDatums", effect: "Write"},
  {name: "viewer.set_input", receiver: "viewer", method: "setInput", effect: "Write"},
  {name: "viewer.set_selection", receiver: "viewer", method: "setSelection", effect: "Write"},
].map(row => Object.freeze(row)));
export const EVENT_DOM_NAMES = Object.freeze({
  "model-dropped": "model.dropped",
  "model-load-failed": "model.load_failed",
  "model-loaded": "model.loaded",
  "render-failed": "render.failed",
  "render-lost": "render.lost",
  "render-restored": "render.restored",
  "viewer-camera-changed": "viewer.camera_changed",
  "viewer-hover-changed": "viewer.hover_changed",
  "viewer-selection-changed": "viewer.selection_changed",
});
export const HOST_EVENTS = Object.freeze(["cinema-viewer-ready", "cinema-viewer-warning", "cinema-viewer-failed", "cinema-viewer-contextmenu"]);
export const LOCAL_ERROR_CODES = Object.freeze(["AssetLoadFailed", "Cancelled", "CapabilityMissing", "DriverFailed", "DriverSetupFailed", "InvalidValue", "LimitExceeded", "RenderFailed", "RenderRecovering", "UnsupportedFormat", "UnknownCommand", "UnknownField", "VersionSkew"]);

export class CinemaError extends Error {
  constructor({code, message, path = '', line, column, hint = '', details, answered_for} = {}) {
    super(message ?? hint ?? '');
    this.name = 'CinemaError';
    this.code = code;
    this.path = path;
    if (line !== undefined) this.line = line;
    if (column !== undefined) this.column = column;
    this.hint = hint;
    this.details = details;
    this.answered_for = answered_for;
    this.result = null;
  }
}

const asCinemaError = e => e instanceof CinemaError ? e
  : new CinemaError({code: e?.code ?? 'DriverFailed', message: e?.message, path: e?.path, line: e?.line, column: e?.column,
    hint: e?.hint ?? String(e?.message ?? e), details: e?.details, answered_for: e?.answered_for});

export function requireComplete(result) {
  if (result?.status === 'complete' && result.incomplete === false) return result;
  const first = result?.errors?.[0] ?? result?.warnings?.[0];
  throw new CinemaError({code: first?.code ?? 'DriverFailed', message: first?.message ?? `The call ended as ${result?.status}.`,
    path: first?.path ?? '', hint: first?.hint ?? '', details: first?.details, answered_for: result?.answered_for});
}

export function createClient(transport) {
  const names = new Set(COMMANDS.map(row => row.name));
  const call = async (name, input, options) => {
    if (!names.has(name)) throw new CinemaError({code: 'UnknownCommand', path: '/name', hint: 'Use a command in this selected catalog.'});
    try {
      return await transport.call(name, input, options);
    } catch (e) {
      throw asCinemaError(e);
    }
  };
  const method = name => (input = {}, options) => call(name, input, options);
  const models = {};
  const client = {call, close: () => transport.close()};
  for (const row of COMMANDS) {
    if (row.receiver === 'models') models[row.method] = method(row.name);
    else if (row.receiver === 'viewer') client[row.method] = method(row.name);
  }
  client.models = Object.freeze(models);
  return Object.freeze(client);
}
