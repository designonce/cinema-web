// Generated from catalog.json and element.json; do not edit.
export const COMMANDS = Object.freeze([
  {name: "diagnostics.graphics", receiver: "viewer", method: "getGraphics", effect: "Read"},
  {name: "events.read", receiver: "viewer", method: "readEvents", effect: "Read"},
  {name: "events.subscribe", receiver: "viewer", method: "subscribeEvents", effect: "Write"},
  {name: "events.unsubscribe", receiver: "viewer", method: "unsubscribeEvents", effect: "Write"},
  {name: "model.drop", receiver: "models", method: "drop", effect: "Write"},
  {name: "model.info", receiver: "models", method: "info", effect: "Read"},
  {name: "model.list", receiver: "models", method: "list", effect: "Read"},
  {name: "model.load", receiver: "models", method: "load", effect: "Write"},
  {name: "session.describe", receiver: "renderer", method: "describe", effect: "Read"},
  {name: "session.status", receiver: "renderer", method: "status", effect: "Read"},
  {name: "view.get_camera", receiver: "viewer", method: "getCamera", effect: "Read"},
  {name: "view.set_camera", receiver: "viewer", method: "setCamera", effect: "Write"},
  {name: "view.set_focus", receiver: "viewer", method: "setFocus", effect: "Write"},
  {name: "view.set_spin", receiver: "viewer", method: "setSpin", effect: "Write"},
  {name: "view.stop", receiver: "viewer", method: "stop", effect: "Write"},
  {name: "viewer.get_attributes", receiver: "viewer", method: "getAttributes", effect: "Read"},
  {name: "viewer.resize", receiver: "viewer", method: "resize", effect: "Write"},
  {name: "viewer.set_attributes", receiver: "viewer", method: "setAttributes", effect: "Write"},
  {name: "viewer.set_input", receiver: "viewer", method: "setInput", effect: "Write"},
].map(row => Object.freeze(row)));
export const EVENT_DOM_NAMES = Object.freeze({
  "model-dropped": "model.dropped",
  "model-load-failed": "model.load_failed",
  "model-loaded": "model.loaded",
  "render-failed": "render.failed",
  "render-lost": "render.lost",
  "render-restored": "render.restored",
  "viewer-camera-changed": "viewer.camera_changed",
});
export const HOST_EVENTS = Object.freeze(["cinema-viewer-ready", "cinema-viewer-warning", "cinema-viewer-failed", "cinema-viewer-contextmenu", "model-load-progress"]);
export const LOCAL_ERROR_CODES = Object.freeze(["AssetLoadFailed", "Cancelled", "CapabilityMissing", "DriverFailed", "DriverSetupFailed", "InvalidValue", "LimitExceeded", "RenderFailed", "RenderRecovering", "UnsupportedFormat", "UnknownCommand", "UnknownField", "VersionSkew", "ModelLoadFailed", "WorkerLost", "WorkerUnavailable"]);

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
