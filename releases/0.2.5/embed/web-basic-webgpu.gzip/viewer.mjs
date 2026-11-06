// Copyright (C) 2026 Admix Pty. Ltd.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { createClient, CinemaError } from './client.mjs';

// Build-specific entry configuration. C keeps its exact artifact identity and GL loss policy.
const ENTRY = Object.freeze({
  profile: 'web-basic-webgpu', glue: 'renderer_webgpu.js', wasm: 'renderer-webgpu.wasm',
  level: 'B', restoredByEvent: false,
  context: () => null,
});

// wgpu 30's adapter conversion rejects undefined but not WebGPU's null. This override exists
// only while wgpu creates its Promise; the original requestAdapter returns before any await.
if (ENTRY.level === 'B') globalThis.cinemaGuardAdapterRequest = () => {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return () => {};
  const own = Object.getOwnPropertyDescriptor(gpu, 'requestAdapter');
  const request = gpu.requestAdapter;
  Object.defineProperty(gpu, 'requestAdapter', {
    configurable: true, writable: true,
    value: async function(options) {
      for (let attempt = 0; attempt < 3; ++attempt) {
        const adapter = await request.call(this, options);
        if (adapter != null) return adapter;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('WebGPU adapter unavailable after three requests');
    },
  });
  return () => {
    if (own) Object.defineProperty(gpu, 'requestAdapter', own);
    else delete gpu.requestAdapter;
  };
};

const DEFAULT_BYTES = 67108864;
const MAX_BYTES = 268435456;
// The `confirmRecovery` refusal when the World became unsafe again during an episode (D-527).
const WORLD_UNSAFE_HINT = 'The renderer World became unsafe; the next attempt replaces it.';
const decoder = new TextDecoder();
const modelId = id => typeof id === 'string' && /^m[1-9][0-9]*$/.test(id);
// Rust gives the keys of a JSON value object in sorted order and the fields of a typed struct in
// declaration order, so objects are compared with their keys sorted. Arrays keep their order.
const canonical = v => Array.isArray(v) ? v.map(canonical)
  : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const error = (code, path, hint, details = null) => new CinemaError({code, path, hint, details});
const complete = (reply) => reply?.status === 'complete' && reply.incomplete === false && reply.data !== null;
const modelOf = (reply) => reply.data?.info?.model ?? reply.data?.model;

// Calls that answer during recovery and after a terminal failure.
const READABLE_CALLS = ['session.describe', 'session.status', 'events.read', 'diagnostics.graphics'];
const READABLE_METHODS = ['getAttributes', 'getCamera', 'readEvents', 'getGraphics'];

const MAX_WARNINGS = 64;
const RIGHT_BUTTON = 2;
const CLICK_DISTANCE = 4;
const CONTROL_ATTRIBUTES = [['controls', 'controls'], ['tools', 'tools']];
const controlValue = (name, value) => name === 'tools'
  ? (value == null ? ['select', 'view-cube'] : value.trim() ? value.trim().split(/\s+/) : [])
  : value ?? 'on';
const CONTROL_FIELDS = {
  preset: ['default', 'cinema'], pivot: {rule: ['scheme', 'visible-retained-look-bounds', 'cursor-centre', 'picked-or-target', 'target']},
  focus: ['body-until-pan', 'off'], orbit: {path: ['single-axis', 'yaw-pitch'], gain: [0, 1], upright: ['recover', 'instant']},
  pan: {gain: [0, 100]}, zoom: {law: ['linear', 'exponential'], gain: [0, 100], drag_gain: [0, 100], anchor: ['cursor', 'target']},
  touch: {mode: ['independent-extra', 'centroid-suspend'], pan_slop: [0, 32, true], orbit_gain: [0, 1], twist_min_spread: [0, 100, true]},
  inertia: ['onshape-and-touch', 'off'],
};
function checkedControls(value) {
  if (value === 'default' || value === 'cinema') return {preset: value};
  const check = (part, fields, path) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw error('InvalidValue', path, 'Expected a camera control record.');
    for (const [name, entry] of Object.entries(part)) {
      const rule = fields[name], field = `${path}/${name}`;
      if (!rule) throw error('UnknownField', field, 'Unknown camera control field.');
      if (entry === null) continue;
      if (!Array.isArray(rule)) check(entry, rule, field);
      else if (typeof rule[0] === 'number') {
        if (entry !== 'mapping-default' || !['gain'].includes(name) || !['/camera-controls/orbit', '/camera-controls/zoom'].includes(path)) {
          if (typeof entry !== 'number' || !Number.isFinite(entry) || (rule[2] ? entry < rule[0] : entry <= rule[0]) || entry > rule[1])
            throw error('InvalidValue', field, 'Camera control gain is out of range.');
        }
      } else if (!rule.includes(entry)) throw error('InvalidValue', field, 'Unknown camera control choice.');
    }
  };
  check(value, CONTROL_FIELDS, '/camera-controls');
  return structuredClone(value);
}
const RELEASE_MENU_MS = 100;
const GLOBAL_ATTRIBUTES = new Set(['id', 'class', 'style', 'hidden', 'tabindex', 'slot', 'title', 'lang', 'dir', 'role', 'part',
  'exportparts', 'is', 'translate', 'draggable', 'contenteditable', 'inert', 'popover', 'autofocus', 'nonce', 'spellcheck',
  'accesskey', 'enterkeyhint', 'inputmode', 'autocapitalize']);
const isGlobalAttribute = name => GLOBAL_ATTRIBUTES.has(name) || /^(aria-|data-)/.test(name) || (name.startsWith('on') && name in HTMLElement.prototype);

// Reads the startup attributes once. A malformed value is reported through `warn` and the default
// is used; a well-formed request that this build cannot honour throws `CapabilityMissing`.
function optionsOf(element, warn) {
  const refuse = (path, what) => { throw error('CapabilityMissing', path, `${what} is not available in this viewer.`); };
  if (element.hasAttribute('src')) refuse('/src', 'The src attribute');
  if (element.children.length) refuse('/children', 'Child elements');
  if (element.hasAttribute('cache-namespace')) refuse('/cache-namespace', 'A cache namespace');
  if (element.getAttribute('cache') === 'best-effort') refuse('/cache', 'Best-effort caching');
  const value = element.getAttribute('recovery-bytes');
  let recoveryBytes = DEFAULT_BYTES;
  if (value !== null) {
    if (/^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= MAX_BYTES) recoveryBytes = Number(value);
    else warn('/recovery-bytes', `Expected a decimal byte count from 0 to ${MAX_BYTES}; the default is used.`);
  }
  const mode = element.getAttribute('scene-mode');
  // A well-formed mode other than `basic` is a request this build cannot honour (D-973).
  if (mode !== null && mode !== 'basic' && /^[a-z][a-z0-9-]*$/.test(mode)) refuse('/scene-mode', `The scene mode ${mode}`);
  for (const [key, allowed] of [['up-axis', ['z', 'y']], ['scene-mode', ['basic']], ['cache', ['off']]]) {
    const v = element.getAttribute(key);
    if (v !== null && !allowed.includes(v)) warn(`/${key}`, `Expected ${allowed.join(' or ')}; the default is used.`);
  }
  for (const name of element.getAttributeNames())
    if (!CinemaViewerElement.observedAttributes.includes(name) && !isGlobalAttribute(name)) warn(`/${name}`, 'Unknown attribute; it has no effect.');
  const axis = element.getAttribute('up-axis');
  return {upAxis: axis === 'y' ? 'y' : 'z', recoveryBytes,
    allowFallbackAdapter: element.hasAttribute('allow-fallback-adapter')};
}

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function identity(manifest) {
  if (manifest.manifest_version !== 1 || manifest.product !== 'embed' ||
      ![ENTRY.profile, 'web-step-webgl2', 'web-step-webgpu'].includes(manifest.profile) ||
      manifest.protocol_version !== 1 || manifest.supported_protocol_min !== 1 || manifest.supported_protocol_max !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.catalog_hash) ||
      !(manifest.render_package_version === '1.3' || (manifest.render_package_version?.major === 1 && manifest.render_package_version?.minor === 3)) ||
      typeof manifest.artifact_version !== 'string' || !manifest.artifact_version || !manifest.files ||
      (manifest.profile === ENTRY.profile ? manifest.worker !== null || manifest.kernel_execution != null :
        manifest.kernel_execution !== 'worker' || manifest.worker?.worker_protocol_version !== 2 ||
        manifest.worker.worker_supported_protocol_min !== 2 || manifest.worker.worker_supported_protocol_max !== 2))
    throw error('VersionSkew', '', `The selected ${ENTRY.profile} release is incomplete or mismatched.`);
}
function fileIdentity(manifest, path) {
  const entry = manifest.files[path];
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes))
    throw error('VersionSkew', '', `Missing file identity: ${path}.`);
  return entry;
}
async function checkedFile(base, manifest, path, signal) {
  const entry = fileIdentity(manifest, path);
  const response = await fetch(new URL(path, base), {signal, cache: 'no-store'}).catch(e => {
    if (signal?.aborted) throw e;
    throw error('AssetLoadFailed', '', `Could not fetch ${path}.`, {asset: path, cause: 'network'});
  });
  if (!response.ok) throw error('AssetLoadFailed', '', `Could not fetch ${path}.`, {asset: path, cause: `http_${response.status}`});
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== entry.bytes || await digest(buffer) !== entry.sha256)
    throw error('VersionSkew', '', `File identity mismatch: ${path}.`);
  return buffer;
}
// Direct npm imports do not pass through the loader. Resolve the same checked gzip
// variant from the release index rather than looking for a raw WASM that is not shipped.
async function compressedWasm(base, manifest, signal) {
  const response = await fetch(new URL('../../index.json', base), {signal, cache: 'no-store'});
  if (!response.ok) throw error('VersionSkew', '', 'Missing release index.');
  const index = await response.json();
  const variant = index.builds?.find(build => build.profile === manifest.profile)?.variants
    ?.find(value => value.id === 'gzip');
  const file = variant?.files?.[ENTRY.wasm];
  if (index.artifact_version !== manifest.artifact_version || variant?.path !==
      new URL(base).pathname.split('/').filter(Boolean).slice(-2).join('/') ||
      file?.path !== `${ENTRY.wasm}.gz.wasm` || !/^[a-f0-9]{64}$/.test(file.stored?.sha256) ||
      !Number.isSafeInteger(file.stored?.bytes) || file.decoded?.bytes !== fileIdentity(manifest, ENTRY.wasm).bytes ||
      file.decoded?.sha256 !== fileIdentity(manifest, ENTRY.wasm).sha256)
    throw error('VersionSkew', '', 'Compressed renderer identity mismatch.');
  const stored = await fetch(new URL(file.path, base), {signal, cache: 'no-store'});
  if (!stored.ok) throw error('AssetLoadFailed', '', 'Could not fetch the compressed renderer.');
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength !== file.stored.bytes || await digest(bytes) !== file.stored.sha256)
    throw error('VersionSkew', '', 'Compressed renderer identity mismatch.');
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
async function release(base, signal) {
  const response = await fetch(new URL('manifest.json', base), {signal, cache: 'no-store'}).catch(e => {
    if (signal?.aborted) throw e;
    throw error('AssetLoadFailed', '', 'Could not fetch the release manifest.', {asset: 'manifest.json', cause: 'network'});
  });
  if (!response.ok) throw error('VersionSkew', '', 'Missing release manifest.');
  const manifest = await response.json();
  identity(manifest);
  const catalogPath = Object.keys(manifest.files).find(p => p.endsWith('/catalog.json'));
  if (!catalogPath) throw error('VersionSkew', '', 'Missing selected catalog.');
  const bytes = await checkedFile(base, manifest, catalogPath, signal);
  const prefix = new TextEncoder().encode('cinema-control-catalog/v1\0');
  const hashed = new Uint8Array(prefix.length + bytes.byteLength);
  hashed.set(prefix); hashed.set(new Uint8Array(bytes), prefix.length);
  if (`sha256:${await digest(hashed)}` !== manifest.catalog_hash)
    throw error('VersionSkew', '', 'Catalog hash mismatch.');
  const catalog = JSON.parse(decoder.decode(bytes));
  if (catalog.product !== manifest.product || catalog.profile !== manifest.profile || catalog.protocol_version !== 1)
    throw error('VersionSkew', '', 'Catalog identity mismatch.');
  return manifest;
}

export class CinemaViewerElement extends HTMLElement {
  static get observedAttributes() { return ['up-axis', 'scene-mode', 'cache', 'cache-namespace', 'src', 'recovery-bytes', 'allow-fallback-adapter', 'artifact', 'context-menu', 'controls', 'tools', 'camera-controls']; }
  constructor() {
    super();
    this._generation = 0;
    this._records = new Map();
    this._heldContacts = new Map();
    this._suppressedContacts = new Set();
    this._mousePresses = new Set();
    this._rightPresses = new Map();
    this._releasedMenus = new Map();
    this._contextMenu = 'camera';
    this._reflectingControlAttrs = false;
    this._cameraControls = {preset: 'default'};
    this._cameraControlsPropertyBeforeConnect = false;
    this._cameraControlsInitialized = false;
    this._menuInitialized = false;
    this._menuPropertyBeforeConnect = false;
    this._reserved = 0;
    this._queue = Promise.resolve();
    this._lossEpoch = 0;
    this._restored = false;
    this._dirty = true;
    this._change = 0;
    this._pending = new Set();
    this._loadedEvents = new Map();
    this._heldLoaded = new Map();
    this._deliveredReplayIds = new Set();
    this._expectedWarnings = new Map();
    this._recoveryWarnings = [];
    this._recoveryAttempt = 0;
    this._firstRefusal = null;
    this._recreating = Promise.resolve();
    this._assetBase = new URL('./', import.meta.url);
    this._loadId = 0;
    this.wasmBytes = undefined;
    this._ready = Promise.withResolvers();
    this._ready.promise.catch(() => {});
    this.ready = this._ready.promise;
    this._warnings = []; this._warningsDropped = 0; this._queuedWarnings = []; this._announced = false; this._failedDispatched = false;
    this._visibleSent = true;
    this.capabilities = null;
    this.diagnostics = null;
    this.models = Object.freeze({load: (input, options) => this._load(input, options), info: (input, options) => this.call('model.info', input, options), list: (input, options) => this.call('model.list', input, options), drop: (input, options) => this._drop(input, options)});
  }
  set assetBase(url) { if (this.isConnected) throw error('InvalidValue', '/asset-base', 'Set assetBase before connection.'); this._assetBase = new URL(url, document.baseURI); }
  get assetBase() { return this._assetBase; }
  get recoveryWarnings() { return this._recoveryWarnings.slice(); }
  get cameraControls() { return structuredClone(this._cameraControls); }
  set cameraControls(value) {
    const patch = checkedControls(value);
    if (!this._cameraControlsInitialized) this._cameraControlsPropertyBeforeConnect = true;
    this._cameraControls = patch;
    if (this._host) this.setInput({camera_controls: patch}).catch(() => this._warn('/camera-controls', 'Camera control update was refused.'));
  }
  get contextMenu() { return this._contextMenu; }
  set contextMenu(value) {
    if (value !== 'camera' && value !== 'browser')
      throw error('InvalidValue', '/context-menu', 'Expected camera or browser.');
    if (!this._menuInitialized) this._menuPropertyBeforeConnect = true;
    this._setContextMenu(value);
  }
  _setContextMenu(value) {
    if (value === this._contextMenu) return;
    this._discardRight();
    this._contextMenu = value;
  }
  _discardRight() { this._mousePresses.clear(); this._rightPresses.clear(); this._releasedMenus.clear(); }
  get testHooks() {
    const host = this._host;
    if (typeof host?.testPresentedPixels !== 'function') return null;
    const invoke = (name, ...args) => {
      if (!this.isConnected) return Promise.reject(error('RenderFailed', '', 'Viewer disconnected.'));
      return Promise.resolve().then(() => host[name](...args));
    };
    const hooks = {
      presentedPixels: () => invoke('testPresentedPixels'),
      renderStats: () => invoke('testRenderStats'),
    };
    if (typeof host.testDestroyDevice === 'function')
      hooks.destroyDevice = () => invoke('testDestroyDevice');
    if (typeof host.testSetRecoveryStall === 'function')
      hooks.setRecoveryStall = (stage, enabled) => invoke('testSetRecoveryStall', stage, enabled);
    if (typeof host.testForceTrap === 'function')
      hooks.forceTrap = () => invoke('testForceTrap');
    if (typeof host.testForcePipelineFailure === 'function')
      hooks.forcePipelineFailure = () => invoke('testForcePipelineFailure');
    if (typeof host.testSetWorldUnsafe === 'function')
      hooks.setWorldUnsafe = () => invoke('testSetWorldUnsafe');
    return Object.freeze(hooks);
  }
  attributeChangedCallback(name, before, after) {
    if (before === after) return;
    if (name === 'context-menu') {
      if (!this._menuInitialized) return;
      if (after === null || after === 'camera' || after === 'browser') this._setContextMenu(after ?? 'camera');
      else this._warn('/context-menu', 'Expected camera or browser; the current setting is kept.');
      return;
    }
    if (name === 'camera-controls') {
      if (!this._cameraControlsInitialized) return;
      if (after !== null && after !== 'default' && after !== 'cinema') {
        this._warn('/camera-controls', 'Expected default or cinema; the current setting is kept.');
        return;
      }
      this._cameraControls = {preset: after ?? 'default'};
      if (this._host) this.setInput({camera_controls: this._cameraControls}).catch(() => this._warn('/camera-controls', 'Camera control update was refused.'));
      return;
    }
     if (CONTROL_ATTRIBUTES.some(([attribute]) => name === attribute)) {
       if (this._reflectingControlAttrs || !this.isConnected || !this._started) return;
       if (name !== 'tools' && after !== null && after !== 'on' && after !== 'off') {
         this._warn(`/${name}`, 'Expected on or off; the current setting is kept.');
         return;
       }
       const field = CONTROL_ATTRIBUTES.find(([attribute]) => name === attribute)[1];
       void this.setAttributes({attributes: {[field]: controlValue(name, after)}}).then(reply => {
         if (!complete(reply)) this._warn(`/${name}`, reply.errors?.[0]?.hint ?? 'Could not change the live control.');
       }, failure => this._warn(`/${name}`, failure.hint ?? String(failure)));
       return;
     }
    if (this.isConnected && this._started) this._warn(`/${name}`, 'This startup attribute changed after the viewer started; the change has no effect.');
  }
  connectedCallback() {
    if (this._started) return;
    this._started = true;
    // The constructor's promise belongs to the first connection; each reconnection makes a new one.
    if (this._generation > 0) { this._ready = Promise.withResolvers(); this._ready.promise.catch(() => {}); this.ready = this._ready.promise; }
    const generation = ++this._generation;
    this._abort = new AbortController();
    const supplied = this.wasmBytes;
    this._startupWasmBytes = supplied instanceof Uint8Array ? supplied.slice() : supplied instanceof ArrayBuffer ? supplied.slice(0) : supplied;
    this.diagnostics = null; this.capabilities = null;
    this._records.clear(); this._reserved = 0; this._queue = Promise.resolve(); this._announced = false; this._failedDispatched = false; this._failed = false; this._openingHost = false;
    this._warnings = []; this._warningsDropped = 0; this._queuedWarnings = []; this._visibleSent = true;
    if (!this._menuInitialized) {
      this._menuInitialized = true;
      const value = this.getAttribute('context-menu');
      if (value !== null && value !== 'camera' && value !== 'browser')
        this._warn('/context-menu', 'Expected camera or browser; the current setting is kept.');
      else if (!this._menuPropertyBeforeConnect) this._setContextMenu(value ?? 'camera');
    }
    if (!this._cameraControlsInitialized) {
      this._cameraControlsInitialized = true;
      const choice = this.getAttribute('camera-controls');
      if (choice !== null && choice !== 'default' && choice !== 'cinema') this._warn('/camera-controls', 'Expected default or cinema; the current setting is kept.');
      else if (!this._cameraControlsPropertyBeforeConnect) this._cameraControls = {preset: choice ?? 'default'};
    }
    this._attributeObserver?.disconnect();
    this._attributeObserver = new MutationObserver(records => {
      if (generation !== this._generation) return;
      for (const {attributeName: name, oldValue} of records)
        if (!CinemaViewerElement.observedAttributes.includes(name) && !isGlobalAttribute(name) && this.getAttribute(name) !== null && this.getAttribute(name) !== oldValue)
          this._warn(`/${name}`, 'Unknown attribute; it has no effect.');
    });
    this._attributeObserver.observe(this, {attributes: true, attributeOldValue: true});
    this._recovering = false; this._restoring = false; this._restored = false; this._recoveryFailed = false; this._terminalRead = false; this._retired = false;
    this._recoveryAttempt = 0; this._firstRefusal = null; this._recreating = Promise.resolve();
    this._dirty = true; this._recoveryWarnings = []; this._stagedEvents = []; this._replay = null; this._deliveredReplayIds.clear(); this._pending.clear(); this._loadedEvents.clear(); this._heldLoaded.clear(); this._expectedWarnings.clear();
    this._start(generation).catch(e => { if (generation === this._generation) this._fail(e); });
  }
  disconnectedCallback() {
    ++this._generation;
    this._started = false;
    this._abort?.abort();
    this._stepWorker?.close(); this._stepWorker = null;
    this._observer?.disconnect(); this._observer = null;
    this._dprQuery?.removeEventListener('change', this._dprChanged); this._dprQuery = null;
    this._motionQuery?.removeEventListener('change', this._motionChanged); this._motionQuery = null;
    this._restoreObserver?.disconnect(); this._restoreObserver = null;
    this._watchSizeObserver?.disconnect(); this._watchSizeObserver = null;
    this._inputAbort?.abort(); this._inputAbort = null;
    this._discardPair?.();
    this._discardRight();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._timer) clearTimeout(this._timer);
    if (this._watchdog) clearTimeout(this._watchdog);
    this._raf = 0; this._timer = 0; this._watchdog = 0;
    this._host?.close(); this._host = null;
    this._records.clear(); this._pending.clear(); this._stagedEvents = []; this._replay = null; this._loadedEvents.clear(); this._heldLoaded.clear(); this._expectedWarnings.clear(); this._reserved = 0;
    this._canvas = null; this._size = null; this.capabilities = null;
    this._attributeObserver?.disconnect(); this._attributeObserver = null;
    this._ready.reject(error('Cancelled', '', 'Viewer disconnected.', {reason: 'disconnected'}));
  }
  _adapter() { return this.diagnostics?.adapter ?? null; }
  // D-955: the adapter stays in `diagnostics` next to later error fields. `warnings` is always
  // present from `ready` on (D-973).
  _diagnostics(fields = {}) { return {adapter: this._adapter(), ...fields, warnings: this._warnings.slice(), warnings_dropped: this._warningsDropped}; }
  _publishAdapter() { this.diagnostics = this._diagnostics({...this.diagnostics, adapter: this._host?.adapter ?? null}); }
  // Keeps the newest 64 DOM-only warnings. Startup warnings wait for `ready`; later ones dispatch now.
  _warn(path, hint) {
    const warning = {code: 'IgnoredAttribute', message: 'An attribute was ignored.', path, hint};
    this._warnings.push(warning);
    if (this._warnings.length > MAX_WARNINGS) { this._warnings.shift(); ++this._warningsDropped; }
    if (this.diagnostics) this.diagnostics = {...this.diagnostics, warnings: this._warnings.slice(), warnings_dropped: this._warningsDropped};
    if (this._announced) this.dispatchEvent(new CustomEvent('cinema-viewer-warning', {detail: warning}));
    else this._queuedWarnings.push(warning);
  }
  _stepWarning(record) {
    const [kernel_code, bodyText, ...parts] = record.split('|');
    if (!/^KG_[A-Z_]+$/.test(kernel_code) || (bodyText && !/^(0|[1-9][0-9]*)$/.test(bodyText)) || parts.length !== 1)
      throw error('RenderFailed', '/source/bytes', 'Invalid STEP warning from worker.');
    const body = bodyText ? Number(bodyText) : null;
    if (body !== null && !Number.isSafeInteger(body)) throw error('RenderFailed', '/source/bytes', 'Invalid STEP body id.');
    const warning = {code: 'StepDisplayWarning', message: 'STEP display could not verify a source check.',
      path: '/source/bytes', hint: parts[0], details: {kernel_code, body, detail: parts[0]}};
    this._warnings.push(warning);
    if (this._warnings.length > MAX_WARNINGS) { this._warnings.shift(); ++this._warningsDropped; }
    if (this.diagnostics) this.diagnostics = {...this.diagnostics, warnings: this._warnings.slice(), warnings_dropped: this._warningsDropped};
    if (this._announced) this.dispatchEvent(new CustomEvent('cinema-viewer-warning', {detail: warning}));
    else this._queuedWarnings.push(warning);
  }
  // One `cinema-viewer-failed` per generation, after `diagnostics` and `render.failed` (D-973).
  _dispatchFailed(reason, code, message) {
    if (this._failedDispatched || !this._announced) return;
    this._failedDispatched = true;
    this.dispatchEvent(new CustomEvent('cinema-viewer-failed', {detail: {reason, code, message}}));
  }
  _alive(generation) { if (generation !== this._generation || !this.isConnected || this._abort?.signal.aborted) throw error('RenderFailed', '', 'Viewer generation ended.'); }
  _fail(e) {
    // Later errors of the same generation (the startup settling after an abort) keep the first one.
    if (this._failed) return;
    this._failed = true;
    // A raw error (a WASM trap) is not a CinemaError; it gives `RenderFailed` and publishes no event.
    const trap = !e?.code, cinemaError = trap ? error('RenderFailed', '', e?.message ?? String(e)) : e;
    this._discardPair?.(); this._abort?.abort(); this._stepWorker?.close(); this._stepWorker = null; this.diagnostics = this._diagnostics({code: cinemaError.code, path: cinemaError.path ?? '', hint: cinemaError.hint ?? String(e), details: cinemaError.details ?? null}); this._ready.reject(cinemaError);
    console.error('[Cinema] Viewer failed', e, {diagnostics: this.diagnostics, generation: this._generation});
    if (trap) this._dispatchFailed('render_failed', cinemaError.code, cinemaError.hint);
    try { this._host?.close(); } catch { /* a trapped module may refuse every call */ }
    this._host = null; this._dirty = false; this._pending.clear(); this._records.clear(); this._reserved = 0; if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
    this._observer?.disconnect(); this._observer = null; this._inputAbort?.abort(); this._inputAbort = null;
    this._motionQuery?.removeEventListener('change', this._motionChanged); this._motionQuery = null;
    this._attributeObserver?.disconnect(); this._attributeObserver = null;
  }
  // Keeps the first refused input of the episode, which the exhaustion diagnostic would hide.
  _withFirstRefusal(e) {
    if (!this._firstRefusal || e.details != null) return e;
    return {code: e.code, path: e.path, hint: e.hint, details: {first_refusal: this._firstRefusal}};
  }
  // The state that stops with an ended recovery episode or a terminal failure. The host stays open
  // for session.status and events.read.
  _endEpisode() {
    this._recovering = false; this._restoring = false; this._restored = false;
    this._replay = null;
    for (const record of this._stagedEvents) if (record.name === 'model.loaded' && this._records.has(record.payload?.info?.model)) this._deliver(record);
    this._stagedEvents = []; this._dirty = false;
    if (this._timer) clearTimeout(this._timer);
    if (this._watchdog) clearTimeout(this._watchdog);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._timer = this._watchdog = this._raf = 0;
    this._restoreObserver?.disconnect(); this._restoreObserver = null;
    this._watchSizeObserver?.disconnect(); this._watchSizeObserver = null;
  }
  // D-958: Rust keeps the error of a terminal failure of a ready viewer. JS reads it before it
  // delivers `render.failed` and at the start of every call, and sets `diagnostics` from it.
  _readFailure() {
    if (this._terminalRead || !this._host || typeof this._host.failure !== 'function') return false;
    let report;
    try { report = this._host.failure(); } catch { return false; }
    if (report == null) return false;
    const failure = report.error;
    this._terminalRead = true; this._recoveryFailed = true;
    this.diagnostics = this._diagnostics({code: failure.code ?? 'RenderFailed', path: failure.path ?? '', hint: failure.hint ?? String(failure), details: failure.details ?? null});
    this._endEpisode();
    this._dispatchIfUnreadable(report);
    return true;
  }
  // No `render.failed` can be read when the host refused the Failed change or retired (D-527), so
  // the event is dispatched now, with the reason Rust reports.
  _dispatchIfUnreadable(report) {
    this._retired = report.retired === true;
    if (report.published !== false && report.retired !== true) return;
    this._dispatchFailed(report.reason, this.diagnostics.code, this.diagnostics.hint);
  }
  // A retired host answers no request, reads included (D-527, D-981).
  _refuseIfRetired() {
    if (this._retired) throw error('DriverFailed', '', 'The renderer host is retired.', {reason: 'host_retired'});
  }
  _recoveryFailure(e, reason = 'driver_failed') {
    if (this._recoveryFailed) return;
    // Do not claim a terminal failure unless Rust accepted the Failed transition.
    try {
      if (!this._host) throw error('RenderFailed', '', 'Recovery host is unavailable.');
      this._host.failRecovery(reason);
    } catch (failure) {
      this.diagnostics = this._diagnostics({code: failure.code ?? 'DriverFailed', path: failure.path ?? '', hint: failure.hint ?? String(failure), details: failure.details ?? null});
      return;
    }
    this._recoveryFailed = true;
    this.diagnostics = this._diagnostics({code: e.code ?? 'RenderFailed', path: e.path ?? '', hint: e.hint ?? String(e), details: e.details ?? null});
    this._endEpisode();
    let report = null;
    try { report = this._host.failure(); } catch { /* a trapped module */ }
    if (report) this._dispatchIfUnreadable(report);
    if (!this._announced) this._ready.reject(error('RenderFailed', '', this.diagnostics.hint));
    // The host stays open for the reads. Only Rust publishes render.failed.
  }
  _deliver(record) {
    if (record.name === 'model.loaded' && modelId(record.payload?.info?.model)) {
      const id = record.payload.info.model;
      if (this._expectedWarnings.has(id)) {
        if (!same(this._expectedWarnings.get(id), record.payload.warnings)) {
          this.diagnostics = this._diagnostics({code: 'DriverFailed', hint: 'Loaded event and result warnings differ.'});
          return;
        }
        this._expectedWarnings.delete(id);
      } else this._loadedEvents.set(id, record.payload.warnings);
    }
    this.dispatchEvent(new CustomEvent(record.name.replace(/[._]/g, '-'), {detail: record}));
  }
  _flushReplay(generation) {
    const replay = this._replay;
    if (!replay || generation !== this._generation || this._recovering) return;
    if (replay.loaded.size !== replay.ids.length || !replay.restored) return;
    this._replay = null;
    for (const id of replay.ids) { this._deliveredReplayIds.add(id); this._deliver(replay.loaded.get(id)); }
    this._deliver(replay.restored);
  }
  _emit(record, generation) {
    if (generation !== this._generation || typeof record?.name !== 'string' || !record.name || !Object.hasOwn(record, 'payload')) return;
    if (record.name === 'render.failed') {
      this._readFailure();
      this._recoveryFailure(error('RenderFailed', '', 'Renderer recovery failed.'));
      this._deliver(record);
      this._dispatchFailed(record.payload?.reason ?? 'driver_failed', this.diagnostics?.code ?? 'RenderFailed', this.diagnostics?.hint ?? 'Renderer recovery failed.');
      return;
    }
    if (this._recoveryFailed) {
      if (record.name === 'model.loaded') {
        const id = record.payload?.info?.model;
        if (this._records.has(id)) this._deliver(record);
        else if (this._pending.size && modelId(id)) this._heldLoaded.set(id, record);
      } else if (record.name !== 'render.restored') this._deliver(record);
      return;
    }
    if (record.name === 'render.restored') {
      if (this._recovering) this._stagedEvents.push(record);
      else if (this._replay && same(record.payload, this._acceptedRestore) && !this._replay.restored) {
        this._replay.restored = record; this._flushReplay(generation);
      }
      return;
    }
    if (record.name === 'model.loaded') {
      const id = record.payload?.info?.model;
      if (this._deliveredReplayIds.has(id)) return;
      if (this._replay?.ids.includes(id)) {
        if (!this._replay.loaded.has(id)) this._replay.loaded.set(id, record);
        this._flushReplay(generation);
        return;
      }
      if (this._recovering && this._restoring && !this._records.has(id)) {
        this._stagedEvents.push(record);
        return;
      }
      // Do not forward stray loaded records from abandoned attempts after restoration.
      if (!this._recovering && this._acceptedRestore && !this._records.has(id)) {
        if (this._pending.size && modelId(id)) this._heldLoaded.set(id, record);
        return;
      }
    }
    this._deliver(record);
  }
  async _start(generation, restoring = false) {
    if (!restoring) {
      this._options = optionsOf(this, (path, hint) => this._warn(path, hint));
      const root = this.shadowRoot ?? this.attachShadow({mode: 'open'});
      root.replaceChildren();
      const canvas = document.createElement('canvas');
      canvas.tabIndex = 0; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Interactive 3D model viewer');
      canvas.style.cssText = 'width:100%;height:100%;display:block';
      root.append(canvas); this._canvas = canvas;
      if (ENTRY.restoredByEvent) {
        canvas.addEventListener('webglcontextlost', e => {
          if (!e.isTrusted || generation !== this._generation) return;
          e.preventDefault(); this._lost(generation);
        }, {signal: this._abort.signal});
        canvas.addEventListener('webglcontextrestored', e => {
          if (!e.isTrusted || generation !== this._generation || !this._recovering) return;
          this._restored = true; this._restore(generation);
        }, {signal: this._abort.signal});
      }
    }
    this._alive(generation);
    const base = this._assetBase;
    let manifest;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { manifest = await release(base, this._abort.signal); break; }
      catch (e) { if (e.code !== 'VersionSkew' || attempt) throw e; }
    }
    this._alive(generation);
    this._manifest = manifest;
    await checkedFile(base, manifest, ENTRY.glue, this._abort.signal);
    for (const path of Object.keys(manifest.files).filter(p => p.startsWith('snippets/')))
      await checkedFile(base, manifest, path, this._abort.signal);
    const wasm = this._startupWasmBytes === undefined
      ? base.pathname.endsWith('.gzip/')
        ? await this._checkedWasm(manifest, () => compressedWasm(base, manifest, this._abort.signal), generation)
        : await checkedFile(base, manifest, ENTRY.wasm, this._abort.signal)
      : await this._checkedWasm(manifest, this._startupWasmBytes, generation);
    this._alive(generation);
    const glue = await import(new URL(ENTRY.glue, base)).catch(() => {
      throw error('DriverSetupFailed', '', 'The Rust web product could not be loaded.', {component: 'wasm', reason: 'compile'});
    });
    this._alive(generation);
    await glue.default({module_or_path: wasm}).catch(e => {
      throw error('DriverSetupFailed', '', 'The Rust web product could not be instantiated.',
        {component: 'wasm', reason: e instanceof WebAssembly.LinkError ? 'link' : 'compile'});
    });
    this._alive(generation);
    // No canvas context is created here: the product export must handshake first.
    if (typeof glue.openWebViewer !== 'function') throw error('VersionSkew', '', 'The Rust web product does not export openWebViewer.');
    this._openingHost = true;
    const host = await glue.openWebViewer(manifest, {...this._options, generation}, this._canvas, record => this._emit(record, generation),
      info => info?.reason === 'device_lost' ? this._lost(generation) : this._worldLost(generation, info), this._abort.signal);
    try { this._alive(generation); } catch (e) { host?.close(); throw e; }
    this._host = host;
    if (!host || ['call', 'load', 'present', 'input', 'lost', 'invalidateRecovery', 'recreate', 'confirmRecovery', 'failRecovery', 'committedCamera', 'close'].some(name => typeof host[name] !== 'function'))
      throw error('VersionSkew', '', 'The Rust web product lacks the required session and presentation exports.');
    this._client = createClient({call: (name, input, options) => { this._readFailure(); return host.call(name, input, options); }, close: () => host.close()});
    // Set the complete preset/patch before binding events; no initial input sees old motion.
    const configured = await this._client.setInput({camera_controls: this._cameraControls});
    if (!complete(configured)) throw error('InvalidValue', '/camera-controls', 'The startup camera controls were refused.');
    this._alive(generation);
    this.capabilities = host.capabilities;
    this._observeMotion();
    this._publishAdapter();
    this._bind(generation);
    // The Rust startup has passed its warm-up frame, so `ready` does not wait for a size,
    // visibility, a model or a presentation (D-973).
    this._announced = true; this._ready.resolve();
    for (const warning of this._queuedWarnings.splice(0)) this.dispatchEvent(new CustomEvent('cinema-viewer-warning', {detail: warning}));
    this.dispatchEvent(new CustomEvent('cinema-viewer-ready'));
    this._schedule(generation);
  }
  async _checkedWasm(manifest, supplied, generation) {
    const signal = this._abort.signal;
    const path = ENTRY.wasm;
    const entry = fileIdentity(manifest, path);
    let bytes = supplied;
    try {
      if (typeof bytes === 'function') bytes = await bytes(signal);
    } catch {
      if (signal.aborted) this._alive(generation);
      throw error('AssetLoadFailed', '', `Could not load ${path}.`, {asset: path, cause: 'provider'});
    }
    this._alive(generation);
    let buffer;
    if (bytes instanceof Uint8Array) buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    else if (bytes instanceof ArrayBuffer) buffer = bytes.slice(0);
    else throw error('AssetLoadFailed', '', `Could not load ${path}.`, {asset: path, cause: 'provider'});
    if (buffer.byteLength !== entry.bytes || await digest(buffer) !== entry.sha256)
      throw error('VersionSkew', '', `File identity mismatch: ${path}.`);
    return buffer;
  }
  _observeMotion() {
    this._motionQuery?.removeEventListener('change', this._motionChanged);
    this._motionQuery = null;
    try {
      this._motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch { /* A host without media queries uses the normal motion preference. */ }
    this._motionChanged = () => this._host?.setReducedMotion?.(this._motionQuery?.matches === true);
    this._motionChanged();
    this._motionQuery?.addEventListener('change', this._motionChanged);
  }
  async _present(generation) {
    this._alive(generation);
    if (this._recovering || this._recoveryFailed || document.hidden || !this._canvas?.clientWidth || !this._canvas.clientHeight) return false;
    const size = {width: this._canvas.clientWidth, height: this._canvas.clientHeight, dpr: window.devicePixelRatio};
    if (![size.width, size.height, size.dpr].every(n => Number.isFinite(n) && n > 0)) return false;
    const width = Math.round(size.width * size.dpr), height = Math.round(size.height * size.dpr);
    if (!width || !height) return false;
    if (this._canvas.width !== width) this._canvas.width = width;
    if (this._canvas.height !== height) this._canvas.height = height;
    this._size = size;
    const change = this._change, epoch = this._lossEpoch;
    let frame;
    try { this._host.testTrapPoint?.(); frame = await this._host.present(size); }
    catch (e) { if (epoch !== this._lossEpoch || this._recovering) return false; throw e; }
    this._alive(generation);
    if (epoch !== this._lossEpoch || this._recovering) return false;
    if (frame?.presented !== true || frame.generation !== generation) throw error('RenderFailed', '', 'No current presented C frame.');
    this._dirty = this._change !== change;
    return true;
  }
  _schedule(generation) {
    if (this._recoveryFailed) return;
    this._dirty = true; ++this._change;
    if (this._raf || this._presenting || document.hidden || this._recovering || !this._canvas?.clientWidth || !this._canvas.clientHeight) return;
    this._raf = requestAnimationFrame(async () => {
      this._raf = 0;
      if (generation !== this._generation || this._recovering || !this._dirty) return;
      this._presenting = true;
      try {
        await this._present(generation);
      } catch (e) {
        if (generation === this._generation && !this._recovering && !this._recoveryFailed) {
          // A terminal frame failure of a ready viewer is kept by Rust, which publishes
          // `render.failed` (D-958). Any other error ends the element here.
          if (!this._readFailure()) this._fail(e);
        }
      }
      finally {
        this._presenting = false;
        if (this._dirty && this._host && generation === this._generation && !this._recovering && !this._recoveryFailed && !document.hidden) this._schedule(generation);
      }
    });
  }
  _input(input) {
    if (!Number.isSafeInteger(this._ordinal + 1)) throw error('LimitExceeded', '/packet/ordinal', 'Input sequence exhausted.');
    const time = Math.max(this._inputTime, input.time);
    const handled = this._host.input({...input, time, generation: input.generation ?? this._host.inputGeneration(), ordinal: ++this._ordinal});
    this._inputTime = time;
    return handled === true;
  }
  _bind(generation) {
    this._discardPair?.();
    this._discardRight();
    this._inputAbort?.abort();
    this._inputAbort = new AbortController();
    const signal = this._inputAbort.signal, canvas = this._canvas;
    const contacts = this._heldContacts;
    const suppressed = this._suppressedContacts;
    for (const id of contacts.keys()) suppressed.add(id);
    canvas.style.touchAction = this._host?.touchControlsEnabled() === true ? 'none' : 'auto';
    const captured = new Set(), expectedRelease = new Set();
    let pending = null, pairFrame = 0, pairIds = null;
    const discard = () => { pending = null; if (pairFrame) cancelAnimationFrame(pairFrame); pairFrame = 0; };
    this._discardPair = () => {
      discard();
      pairIds = null;
      this._discardRight();
      for (const id of contacts.keys()) suppressed.add(id);
      for (const id of captured) {
        if (canvas.hasPointerCapture(id)) { expectedRelease.add(id); canvas.releasePointerCapture(id); }
      }
      captured.clear();
    };
    const emit = input => this._host ? this._input(input) : false;
    const flush = () => {
      if (!pending) return;
      const sample = pending; pending = null;
      if (generation !== this._generation || this._recovering || this._recoveryFailed || document.hidden || !this.isConnected) return;
      if (suppressed.size) return;
      emit({kind: 'touch_pair', contacts: [...sample.positions].sort((a, b) => a[0] - b[0]).map(([id, css]) => ({id, css})), time: sample.time, generation: sample.generation});
      this._schedule(generation);
    };
    const close = () => { if (pairFrame) cancelAnimationFrame(pairFrame); pairFrame = 0; flush(); };
    const point = (event, rect) => [event.clientX - rect.left, event.clientY - rect.top];
    this._observer?.disconnect();
    this._observer = new ResizeObserver(() => { this._syncVisible(generation); this._schedule(generation); }); this._observer.observe(canvas);
    const send = (kind, event, source = event) => {
      if (!event.isTrusted) return false;
      if (!this._host || this._recovering || this._recoveryFailed || generation !== this._generation) return false;
      const rect = canvas.getBoundingClientRect();
      const input = {kind, x: source.clientX - rect.left, y: source.clientY - rect.top, pointer_id: event.pointerId,
        pointer_type: event.pointerType, buttons: event.buttons, button: event.button, shift: event.shiftKey,
        ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, time: source.timeStamp};
      const handled = emit(input);
      if (handled) { event.preventDefault(); event.stopPropagation(); this._schedule(generation); }
      return handled;
    };
    this._ordinal = 0;
    this._inputTime = 0;
    canvas.addEventListener('pointerdown', e => {
      if (!e.isTrusted) return;
      close();
      if (e.pointerType === 'touch' && suppressed.has(e.pointerId)) return;
      const handled = send('down', e);
      const ownsTouch = e.pointerType === 'touch' && this._host?.touchControlsEnabled() === true && !this._recovering && !this._recoveryFailed;
      if (ownsTouch && !suppressed.has(e.pointerId)) {
        contacts.set(e.pointerId, point(e, canvas.getBoundingClientRect()));
        if (!pairIds && contacts.size === 2) pairIds = [...contacts.keys()].sort((a, b) => a - b);
        if (contacts.size > 2 && !this._host.independentExtraEnabled()) pairIds = null;
        e.preventDefault(); e.stopPropagation();
      }
      let bound = false;
      if (e.pointerType === 'mouse') {
        this._mousePresses.add(e.pointerId);
        if (e.button === RIGHT_BUTTON) this._releasedMenus.clear();
        bound = (e.buttons & RIGHT_BUTTON) && this._contextMenu === 'camera' &&
          this._host?.cameraChordBound(e.buttons, e.ctrlKey, e.shiftKey, e.altKey, e.metaKey);
        const press = this._rightPresses.get(e.pointerId);
        if (bound && !press) {
          const position = point(e, canvas.getBoundingClientRect());
          this._rightPresses.set(e.pointerId, {start: position, last: position,
            eligible: e.button === RIGHT_BUTTON && e.buttons === RIGHT_BUTTON});
        } else if (press && !bound) this._rightPresses.delete(e.pointerId);
        else if (press && e.button !== RIGHT_BUTTON) press.eligible = false;
      }
      if (handled || bound || (ownsTouch && !suppressed.has(e.pointerId))) { canvas.focus({preventScroll: true}); canvas.setPointerCapture(e.pointerId); captured.add(e.pointerId); }
    }, {signal});
    for (const kind of ['pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(kind, e => {
      if (!e.isTrusted) return;
      if (kind === 'pointercancel') {
        if (e.pointerType === 'mouse') { this._mousePresses.delete(e.pointerId); this._rightPresses.delete(e.pointerId); this._releasedMenus.delete(e.pointerId); }
        else if (e.pointerType === 'touch') this._discardPair();
      }
      if (e.pointerType === 'touch' && suppressed.has(e.pointerId) && kind === 'pointermove') {
        e.preventDefault(); e.stopPropagation(); return;
      }
      if (e.pointerType === 'touch' && contacts.has(e.pointerId) && kind === 'pointermove' && pairIds?.includes(e.pointerId)) {
        const samples = e.getCoalescedEvents?.() ?? [];
        const last = samples.length ? samples[samples.length - 1] : e;
        const css = point(last, canvas.getBoundingClientRect());
        contacts.set(e.pointerId, css);
        if (!pending) pending = {positions: new Map(pairIds.map(id => [id, contacts.get(id)])), time: last.timeStamp, generation: this._host.inputGeneration()};
        else { pending.positions.set(e.pointerId, css); pending.time = Math.max(pending.time, last.timeStamp); }
        if (!pairFrame) pairFrame = requestAnimationFrame(() => { pairFrame = 0; flush(); });
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (e.pointerType === 'touch' && contacts.has(e.pointerId) && kind === 'pointermove') {
        const samples = e.getCoalescedEvents?.() ?? [];
        for (const sample of samples.length ? samples : [e]) send(kind, e, sample);
        contacts.set(e.pointerId, point(samples.length ? samples[samples.length - 1] : e, canvas.getBoundingClientRect()));
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (kind !== 'pointermove') {
        if (e.pointerType === 'touch' && contacts.has(e.pointerId) && kind === 'pointerup' && pairIds?.includes(e.pointerId)) {
          const css = point(e, canvas.getBoundingClientRect());
          if (css.some((v, i) => v !== contacts.get(e.pointerId)[i])) {
            contacts.set(e.pointerId, css);
            if (!pending) pending = {positions: new Map(pairIds.map(id => [id, contacts.get(id)])), time: e.timeStamp, generation: this._host.inputGeneration()};
            else { pending.positions.set(e.pointerId, css); pending.time = Math.max(pending.time, e.timeStamp); }
          }
        }
        close();
      }
      const owned = e.pointerType === 'touch' && contacts.has(e.pointerId);
      // Rust clears contact IDs on acknowledgement but needs the last release to end suppression.
      const heldRelease = e.pointerType === 'touch' && suppressed.has(e.pointerId);
      const handled = heldRelease && contacts.size > 1 ? false : send(kind, e);
      if (owned) { e.preventDefault(); e.stopPropagation(); }
      if (e.pointerType === 'mouse') {
        let press = this._rightPresses.get(e.pointerId);
        const position = point(e, canvas.getBoundingClientRect());
        const bound = (e.buttons & RIGHT_BUTTON) && this._contextMenu === 'camera' &&
          this._host?.cameraChordBound(e.buttons, e.ctrlKey, e.shiftKey, e.altKey, e.metaKey);
        if (kind === 'pointermove' && !press && this._mousePresses.has(e.pointerId) && bound) {
          press = {start: position, last: position, eligible: false};
          this._rightPresses.set(e.pointerId, press);
        }
        if (press) {
          if (kind === 'pointermove') {
            press.last = position;
            if (!bound) this._rightPresses.delete(e.pointerId);
            else if (handled && Math.hypot(position[0] - press.start[0], position[1] - press.start[1]) >= CLICK_DISTANCE)
              press.eligible = false;
          } else if (kind === 'pointerup') {
            if (e.button === RIGHT_BUTTON) {
              this._rightPresses.delete(e.pointerId);
              // The release packet has no right button; use the last held chord for cancellation.
              const releaseBound = this._host?.cameraChordBound(e.buttons | RIGHT_BUTTON, e.ctrlKey, e.shiftKey, e.altKey, e.metaKey);
              if (releaseBound) {
                const record = {start: press.start, end: position, until: performance.now() + RELEASE_MENU_MS};
                this._releasedMenus.set(e.pointerId, record);
                setTimeout(() => { if (this._releasedMenus.get(e.pointerId) === record) this._releasedMenus.delete(e.pointerId); }, RELEASE_MENU_MS);
              }
              if (press.eligible && releaseBound && e.buttons === 0 &&
                  Math.hypot(position[0] - press.start[0], position[1] - press.start[1]) < CLICK_DISTANCE)
                this.dispatchEvent(new CustomEvent('cinema-viewer-contextmenu', {
                  detail: {x: position[0], y: position[1], ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey},
                  bubbles: false, composed: false, cancelable: false,
                }));
            } else press.eligible = false;
          }
        }
      }
      if (kind !== 'pointermove') {
        if (e.pointerType === 'mouse' && !e.buttons) this._mousePresses.delete(e.pointerId);
        contacts.delete(e.pointerId);
        if (pairIds?.includes(e.pointerId)) pairIds = null;
        if (!pairIds && contacts.size === 2 && !this._host.independentExtraEnabled())
          pairIds = [...contacts.keys()].sort((a, b) => a - b);
        suppressed.delete(e.pointerId);
        captured.delete(e.pointerId);
        if (canvas.hasPointerCapture(e.pointerId)) {
          expectedRelease.add(e.pointerId);
          canvas.releasePointerCapture(e.pointerId);
        }
      }
    }, {signal});
    canvas.addEventListener('lostpointercapture', e => {
      // Browsers may release capture automatically before pointerup runs; that release is not a gesture loss.
      if (expectedRelease.delete(e.pointerId) || !captured.has(e.pointerId)) return;
      if (e.pointerType === 'mouse') { this._mousePresses.delete(e.pointerId); this._rightPresses.delete(e.pointerId); this._releasedMenus.delete(e.pointerId); }
      else this._discardPair();
      if (e.isTrusted && generation === this._generation && !this._recoveryFailed) emit({kind: 'capture_lost', time: e.timeStamp});
    }, {signal});
    canvas.addEventListener('wheel', e => {
      if (!e.isTrusted || !this._host || this._recovering || this._recoveryFailed || generation !== this._generation || (contacts.size && e.ctrlKey)) return;
      close();
      const rect = canvas.getBoundingClientRect();
      if (emit({kind: 'wheel', x: e.clientX - rect.left, y: e.clientY - rect.top,
        delta_x: e.deltaX, delta_y: e.deltaY, delta_mode: ['pixel', 'line', 'page'][e.deltaMode] ?? 'pixel', source: 'unknown',
        ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, time: e.timeStamp})) {
        e.preventDefault(); e.stopPropagation(); this._schedule(generation);
      }
    }, {signal, passive: false});
    canvas.addEventListener('contextmenu', e => {
      if (!e.isTrusted || e.button !== RIGHT_BUTTON || this._contextMenu !== 'camera') return;
      const id = e.pointerId;
      const rect = canvas.getBoundingClientRect();
      const position = [e.clientX - rect.left, e.clientY - rect.top];
      const candidates = id !== undefined ? [id] : [...new Set([...this._rightPresses.keys(), ...this._releasedMenus.keys()])];
      if (id === undefined && candidates.length !== 1) return;
      for (const candidate of candidates) {
        const press = this._rightPresses.get(candidate);
        const released = this._releasedMenus.get(candidate);
        if (released && performance.now() > released.until) { this._releasedMenus.delete(candidate); continue; }
        const positions = press ? [press.start, press.last] : released ? [released.start, released.end] : [];
        if (positions.some(([x, y]) => Math.hypot(x - position[0], y - position[1]) <= CLICK_DISTANCE)) {
          e.preventDefault();
          if (released) this._releasedMenus.delete(candidate);
          return;
        }
      }
    }, {signal, passive: false});
    for (const phase of ['keydown', 'keyup']) canvas.addEventListener(phase, e => {
      if (!e.isTrusted || e.isComposing || e.target !== canvas || !this._host || this._recovering || this._recoveryFailed) return;
      close();
      if (emit({kind: phase === 'keydown' ? 'key_down' : 'key_up', key: e.key, repeat: e.repeat,
        ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, time: e.timeStamp})) {
        e.preventDefault(); e.stopPropagation(); this._schedule(generation);
      }
    }, {signal});
    // After a terminal failure Rust throws for all input, so no listener calls it; during recovery it returns false.
    canvas.addEventListener('blur', () => { this._discardPair(); if (generation === this._generation && !this._recoveryFailed) emit({kind: 'focus_lost', time: performance.now()}); }, {signal});
    window.addEventListener('blur', () => { this._discardPair(); if (generation === this._generation && !this._recoveryFailed) emit({kind: 'focus_lost', time: performance.now()}); }, {signal});
    document.addEventListener('visibilitychange', () => {
      if (generation !== this._generation) return;
      // The restore clock must follow visibility even if Rust refuses the input.
      this._watchRestore(generation, this._lossEpoch);
      if (document.hidden) this._discardPair();
      this._syncVisible(generation);
      if (!document.hidden) { if (this._restored) this._restore(generation); else this._schedule(generation); }
    }, {signal});
    window.addEventListener('resize', () => { this._discardPair(); this._watchRestore(generation, this._lossEpoch); this._schedule(generation); this._watchDpr(generation); }, {signal});
    window.addEventListener('focus', () => { this._schedule(generation); this._watchDpr(generation); }, {signal});
    this._watchDpr(generation);
  }
  // Tells Rust when the canvas is not visible or has zero size, and when it is again; no resize
  // is sent for zero size and the last positive size stays (D-973).
  _syncVisible(generation) {
    if (generation !== this._generation || this._recoveryFailed || !this._host) return;
    const visible = !document.hidden && !!this._canvas?.clientWidth && !!this._canvas.clientHeight;
    if (visible === this._visibleSent) return;
    if (!Number.isSafeInteger(this._ordinal + 1)) return;
    // Rust applies the visibility flag even when it reports the packet as not delivered, so only a
    // thrown refusal leaves the state unchanged.
    this._input({kind: visible ? 'visibility_restored' : 'visibility_lost', time: performance.now()});
    this._visibleSent = visible;
  }
  _watchDpr(generation) {
    this._dprQuery?.removeEventListener('change', this._dprChanged);
    if (generation !== this._generation) return;
    this._dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this._dprChanged = () => { this._schedule(generation); this._watchDpr(generation); };
    this._dprQuery.addEventListener('change', this._dprChanged);
  }
  _enqueue(work) {
    // Preserve admission order without blocking status, cancellation or reads behind a pending load.
    const admitted = this._queue.then(() => ({task: work()}));
    this._queue = admitted.then(() => {}, () => {});
    return admitted.then(({task}) => task);
  }
  _wake(generation) {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = 0;
      if (generation === this._generation && !this._recovering && !this._recoveryFailed && !document.hidden) this._schedule(generation);
    }, 0);
  }
  async setGolfLiveColours(model, colours) {
    const generation = this._generation;
    return this._enqueue(async () => {
      await this.ready;
      this._readFailure();
      this._refuseIfRetired();
      this._alive(generation);
      if (this._recovering || this._recoveryFailed) throw error('RenderRecovering', '', 'Surface styles are unavailable during recovery.');
      await this._host.setGolfLiveColours([model, colours]);
      this._alive(generation);
      this._wake(generation);
    });
  }
  async call(name, input = {}, options) {
    const generation = this._generation;
    return this._enqueue(async () => {
      this._readFailure();
      this._refuseIfRetired();
      if (!(this._host && READABLE_CALLS.includes(name))) await this.ready;
      this._alive(generation);
      if (options?.signal?.aborted) throw error('Cancelled', '', 'Call aborted before admission.');
      if (this._recoveryFailed && !READABLE_CALLS.includes(name)) throw error('RenderFailed', '', 'Renderer recovery failed.');
      if (this._recovering && !READABLE_CALLS.includes(name)) throw error('RenderRecovering', '', 'Wait for restoration.');
      const command = ['viewer.set_input', 'view.stop', 'view.set_spin', 'view.set_camera', 'view.set_focus'].includes(name);
      const reply = await this._client.call(name, input, options);
      this._alive(generation);
      if (command && reply?.status === 'complete' && reply.incomplete === false) {
        this._discardPair?.();
        if (this._canvas) this._canvas.style.touchAction = this._host.touchControlsEnabled() === true ? 'none' : 'auto';
      }
      if (!['session.describe', 'session.status', 'events.read', 'diagnostics.graphics', 'model.info', 'model.list'].includes(name)) this._wake(generation);
      return reply;
    });
  }
  async _load(input, options) {
    const generation = this._generation;
    // Snapshot before any await; a caller may mutate or reuse an offset view.
    // The key set is checked first, as the native schema check is: an unknown key is `UnknownField`
    // and zero or two source kinds are `InvalidValue`. Then a path or url source is refused
    // before any read or fetch.
    const sourceFields = input?.source;
    if (!sourceFields || typeof sourceFields !== 'object') throw error('InvalidValue', '/source', 'Supply exactly one source kind: package bytes.');
    const keys = Object.keys(sourceFields);
    const unknownKey = keys.find(k => !['bytes', 'path', 'url'].includes(k));
    if (unknownKey !== undefined) throw error('UnknownField', `/source/${unknownKey}`, 'Unknown source field.');
    if (keys.length !== 1) throw error('InvalidValue', '/source', 'Supply exactly one source kind: package bytes.');
    if (keys[0] === 'path') throw error('CapabilityMissing', '/source/path', 'Supply package bytes only; source paths are unavailable.');
    if (keys[0] === 'url') throw error('CapabilityMissing', '/source/url', 'Supply package bytes only; source URLs are unavailable.');
    const {source: supplied, ...loadFields} = input;
    let metadata;
    try { metadata = structuredClone(loadFields); }
    catch { throw error('InvalidValue', '/source', 'Load options must be cloneable.'); }
    const source = supplied.bytes;
    let bytes;
    if (source instanceof Uint8Array) bytes = source.slice();
    else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source).slice();
    else if (source instanceof Blob) { const raw = await source.arrayBuffer(); this._alive(generation); bytes = new Uint8Array(raw); }
    else throw error('InvalidValue', '/source/bytes', 'Expected Uint8Array, ArrayBuffer or Blob.');
    const step = decoder.decode(bytes.subarray(0, 128)).trimStart().startsWith('ISO-10303-21;');
    const pkg = bytes.length >= 8 && decoder.decode(bytes.subarray(0, 8)) === 'FGRPKG\0\x01';
    const stl = bytes.length >= 84 && 84 + new DataView(bytes.buffer, bytes.byteOffset + 80, 4).getUint32(0, true) * 50 === bytes.length ||
      decoder.decode(bytes.subarray(0, 6)).toLowerCase() === 'solid ';
    return this._enqueue(async () => {
      await this.ready; this._alive(generation);
      if (options?.signal?.aborted) throw error('Cancelled', '', 'Load aborted before admission.');
      const format = metadata.format;
      const accepted = this._manifest.worker ? ['render-package', 'step', 'stl', 'obj'] : ['render-package'];
      const selected = format === 'rpkg' ? 'render-package' : format ??
        (pkg ? 'render-package' : step ? 'step' : stl ? 'stl' : null);
      if (!accepted.includes(selected) || (selected === 'render-package' && !pkg))
        throw error('UnsupportedFormat', '/format', `Accepted formats: ${accepted.join(', ')}.`,
          {accepted_formats: accepted});
      delete metadata.format;
      if (this._recoveryFailed) throw error('RenderFailed', '', 'Renderer recovery failed.');
      if (this._recovering) throw error('RenderRecovering', '', 'Wait for restoration.');
      const epoch = this._lossEpoch;
      let converter;
      if (selected !== 'render-package') {
        if (!this._stepWorker) {
          await checkedFile(this._assetBase, this._manifest, 'step-worker.mjs', this._abort.signal);
          this._alive(generation);
          const {StepWorker} = await import(new URL('step-worker.mjs', this._assetBase));
          this._alive(generation);
          this._stepWorker = new StepWorker(this._assetBase, this._manifest, error);
        }
        const loadId = `load-${++this._loadId}`;
        const progress = stage => {
          if (generation === this._generation && !options?.signal?.aborted)
            this.dispatchEvent(new CustomEvent('model-load-progress', {detail: {load_id: loadId, stage}}));
        };
        const conversion = await this._stepWorker.load(bytes, options?.signal, progress, selected);
        converter = this._stepWorker.converter;
        this._alive(generation);
        bytes = conversion.bytes;
        for (const warning of conversion.warnings) this._stepWarning(warning);
        progress('upload');
      }
      const limit = this._options.recoveryBytes, retainedBytes = this._reserved, length = bytes.byteLength;
      let copy, reason;
      if (length > limit - retainedBytes) reason = 'budget_exceeded';
      else {
        this._reserved += length;
        try { copy = bytes.slice(); }
        catch { this._reserved -= length; reason = 'allocation_failed'; }
      }
      const outcome = reason ? {kind: 'not_retained', reason, model_bytes: length, retained_bytes: retainedBytes, limit_bytes: limit} : {kind: 'retained'};
      // Admission owns the immutable bytes until the terminal load result is reconciled.
      const settled = Promise.withResolvers();
      const reservation = {copy, length, outcome, options: metadata, settled: settled.promise};
      this._pending.add(reservation);
      let committed = false;
      try {
        const reply = await this._host.load({...metadata, source: {bytes}}, outcome, options);
        this._alive(generation);
        if (complete(reply)) {
          const model = modelOf(reply);
          if (!modelId(model)) throw error('DriverFailed', '', 'Complete load has no valid model ID.');
          this._records.set(model, {copy: reservation.copy, outcome: reason ? {reason, length, retainedBytes, limitBytes: limit} : null, options: reservation.options, length});
          committed = true;
          const warning = reply.warnings?.filter(w => w.code === 'ModelBytesNotRetained') ?? [];
          if (reason ? warning.length !== 1 || warning[0].path !== '/source/bytes' || !same(warning[0].details,
            {model, reason, model_bytes: length, retained_bytes: retainedBytes, limit_bytes: limit}) : warning.length !== 0)
            throw error('DriverFailed', '', 'Rust did not finalize the typed retention outcome.');
          if (this._loadedEvents.has(model)) {
            if (!same(this._loadedEvents.get(model), reply.warnings))
              throw error('DriverFailed', '', 'Loaded event and result warnings differ.');
            this._loadedEvents.delete(model);
          } else this._expectedWarnings.set(model, reply.warnings);
          const held = this._heldLoaded.get(model);
          if (held) { this._heldLoaded.delete(model); this._deliver(held); }
        }
        if (this._lossEpoch === epoch) this._wake(generation);
        return converter ? {...reply, converter} : reply;
      } finally {
        this._pending.delete(reservation);
        if (!this._pending.size) this._heldLoaded.clear();
        if (copy && !committed && generation === this._generation) this._reserved -= length;
        settled.resolve();
      }
    });
  }
  async _drop(input, options) {
    const reply = await this.call('model.drop', input, options);
    if (complete(reply)) {
      const entry = this._records.get(input.model);
      if (entry?.copy) this._reserved -= entry.length;
      this._records.delete(input.model);
      this._loadedEvents.delete(input.model); this._expectedWarnings.delete(input.model);
    }
    return reply;
  }
  _watchRestore(generation, epoch) {
    if (generation !== this._generation || epoch !== this._lossEpoch || !this._recovering || this._recoveryFailed || !this._watchSizeObserver) return;
    if (this._watchdog) clearTimeout(this._watchdog);
    this._watchdog = 0;
    const now = performance.now();
    if (this._restoreWatchStarted !== null) {
      this._restoreWatchRemaining -= now - this._restoreWatchStarted;
      this._restoreWatchStarted = null;
    }
    if (document.hidden || !this._canvas?.clientWidth || !this._canvas.clientHeight) return;
    if (this._restoreWatchRemaining <= 0) {
      this._recoveryFailure(error('RenderFailed', '', 'WebGL context restoration timed out.'), 'webgl_restore_timeout');
      return;
    }
    this._restoreWatchStarted = now;
    this._watchdog = setTimeout(() => this._watchRestore(generation, epoch), this._restoreWatchRemaining);
  }
  _lost(generation) {
    if (generation !== this._generation || this._recoveryFailed) return;
    // Context loss before `ready` is a startup failure; no recovery runs (D-973).
    if (!this._announced) {
      this._fail(error('RenderFailed', '', 'The WebGL context was lost before the viewer was ready.', {stage: this._openingHost ? 'warmup' : 'device', reason: 'context_lost'}));
      return;
    }
    const repeated = this._recovering;
    // D-516: one attempt count per loss episode; a loss during recovery continues the episode.
    if (!repeated) { this._recoveryAttempt = 0; this._firstRefusal = null; }
    if (this._watchdog) clearTimeout(this._watchdog);
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0;
    this._restoreObserver?.disconnect(); this._restoreObserver = null;
    this._watchSizeObserver?.disconnect(); this._watchSizeObserver = null;
    this._recovering = true;
    this._discardRight();
    this._motionQuery?.removeEventListener('change', this._motionChanged); this._motionQuery = null;
    // The next restored event starts a new attempt after the invalidated recreate has ended.
    this._restoring = false;
    this._restored = !ENTRY.restoredByEvent; this._acceptedRestore = null; this._stagedEvents = []; this._replay = null; this._deliveredReplayIds.clear();
    ++this._lossEpoch;
    if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
    try {
      if (!this._host) throw error('RenderFailed', '', 'Context lost during startup.');
      // A second loss invalidates the active attempt without a second render.lost event.
      if (repeated) this._host.invalidateRecovery();
      else this._host.lost();
    } catch (e) { this._recoveryFailure(e); return; }
    if (repeated && this._recoveryAttempt >= 3) {
      this._recoveryFailure(this._withFirstRefusal(error('RenderFailed', '', 'Renderer recovery exhausted.')), 'attempts_spent');
      return;
    }
    const epoch = this._lossEpoch;
    // Observation uses visible elapsed time; reconstruction has its own attempt deadline.
    this._restoreWatchRemaining = 30000;
    this._restoreWatchStarted = null;
    this._watchSizeObserver = new ResizeObserver(() => this._watchRestore(generation, epoch));
    this._watchSizeObserver.observe(this._canvas);
    this._watchRestore(generation, epoch);
    if (!ENTRY.restoredByEvent) queueMicrotask(() => this._restore(generation));
  }
  // D-527: the live host started a World recovery itself. The canvas, context and device are
  // kept, so the attempt starts now: no context event or restore watchdog (D-513) applies.
  // Called by Rust during a turn; it must not call back into the host synchronously.
  _worldLost(generation, _info) {
    if (generation !== this._generation || this._recoveryFailed || this._recovering) return;
    if (!this._host) { this._recoveryFailure(error('RenderFailed', '', 'Renderer World failed during startup.')); return; }
    // D-516: a World recovery is a new loss episode.
    this._recoveryAttempt = 0; this._firstRefusal = null;
    if (this._watchdog) clearTimeout(this._watchdog);
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0; this._watchdog = 0;
    this._restoreObserver?.disconnect(); this._restoreObserver = null;
    this._watchSizeObserver?.disconnect(); this._watchSizeObserver = null;
    this._recovering = true; this._restoring = false;
    this._discardRight();
    this._motionQuery?.removeEventListener('change', this._motionChanged); this._motionQuery = null;
    this._restored = true; this._acceptedRestore = null; this._stagedEvents = []; this._replay = null; this._deliveredReplayIds.clear();
    ++this._lossEpoch;
    if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0;
    queueMicrotask(() => this._restore(generation));
  }
  async _restore(generation) {
    if (!this._recovering || !this._restored || generation !== this._generation || this._restoring) return;
    this._watchRestore(generation, this._lossEpoch);
    if (this._recoveryFailed) return;
    // The restore event alone does not prove that the owned WebGL context is usable.
    const gl = ENTRY.restoredByEvent ? ENTRY.context(this._canvas) : null;
    if (ENTRY.restoredByEvent && (!gl || gl.isContextLost())) {
      if (!this._timer) {
        const epoch = this._lossEpoch;
        this._timer = setTimeout(() => {
          if (generation !== this._generation || epoch !== this._lossEpoch) return;
          this._timer = 0; this._restore(generation);
        }, 100);
      }
      return;
    }
    if (this._watchdog) clearTimeout(this._watchdog);
    this._watchdog = 0;
    this._watchSizeObserver?.disconnect(); this._watchSizeObserver = null;
    this._restoreWatchStarted = null;
    if (document.hidden || !this._canvas.clientWidth || !this._canvas.clientHeight) {
      this._restoreObserver?.disconnect();
      this._restoreObserver = new ResizeObserver(() => {
        if (!document.hidden && this._canvas.clientWidth && this._canvas.clientHeight) {
          this._restoreObserver.disconnect(); this._restoreObserver = null;
          this._restore(generation);
        }
      });
      this._restoreObserver.observe(this._canvas);
      return;
    }
    this._restoring = true;
    const epoch = this._lossEpoch;
    // A load may commit while its JS promise has not yet published its model ID.
    let waitTimer;
    try {
      await Promise.race([
        Promise.allSettled([...this._pending].map(entry => entry.settled)),
        new Promise((_, reject) => { waitTimer = setTimeout(() => reject(error('RenderFailed', '', 'Pending loads did not settle after context loss.')), 30000); }),
      ]);
    } catch (e) { if (generation === this._generation && epoch === this._lossEpoch && !this._recoveryFailed) { this._restoring = false; this._recoveryFailure(e, 'pending_load_failure'); } return; }
    finally { clearTimeout(waitTimer); }
    if (generation !== this._generation || this._recoveryFailed || !this._recovering || epoch !== this._lossEpoch) return;
    // Rust refuses a new attempt while an invalidated one still holds the device.
    let settleTimer;
    try {
      await Promise.race([this._recreating,
        new Promise((_, reject) => { settleTimer = setTimeout(() => reject(error('RenderFailed', '', 'An invalidated recovery attempt did not end.')), 30000); })]);
    } catch (e) { if (generation === this._generation && epoch === this._lossEpoch && !this._recoveryFailed) { this._restoring = false; this._recoveryFailure(e, 'abandoned_attempt'); } return; }
    finally { clearTimeout(settleTimer); }
    if (generation !== this._generation || this._recoveryFailed || !this._recovering || epoch !== this._lossEpoch) return;
    const entries = [...this._records];
    let camera;
    try {
      camera = await this._host.committedCamera(); this._alive(generation);
      if (this._recoveryFailed || !this._recovering || epoch !== this._lossEpoch) return;
    }
    catch (e) { if (generation === this._generation && epoch === this._lossEpoch && !this._recoveryFailed) { this._restoring = false; this._recoveryFailure(e?.code ? e : error('RenderFailed', '', 'Could not preserve committed camera.'), 'camera_failure'); } return; }
    for (;;) {
      if (document.hidden || !this._canvas.clientWidth || !this._canvas.clientHeight) {
        this._restoring = false;
        this._restore(generation);
        return;
      }
      if (this._recoveryAttempt >= 3) {
        this._recoveryFailure(this._withFirstRefusal(error('RenderFailed', '', 'Renderer recovery exhausted.')), 'attempts_spent');
        return;
      }
      const attempt = ++this._recoveryAttempt;
      // A read begun before loss may complete while the next attempt is starting.
      // Its committed pre-loss loads keep their session read order.
      for (const event of this._stagedEvents) if (event.name === 'model.loaded' && this._records.has(event.payload?.info?.model)) this._deliver(event);
      this._stagedEvents = []; // Failed-attempt records must never reach the page.
      let report;
      try {
        const pending = this._host.recreate(entries.map(([id, entry]) => ({previous_model: id, bytes: entry.copy ?? null, options: entry.options,
          outcome: entry.outcome ? {kind: 'not_retained', reason: entry.outcome.reason, model_bytes: entry.length,
            retained_bytes: entry.outcome.retainedBytes, limit_bytes: entry.outcome.limitBytes} : {kind: 'retained'}})),
          camera, attempt, this._options.recoveryBytes);
        this._recreating = Promise.resolve(pending).then(() => {}, () => {});
        report = await pending;
      } catch (e) {
        if (generation !== this._generation || this._recoveryFailed || !this._recovering || epoch !== this._lossEpoch) return;
        if (e?.code === 'RenderFailed') {
          this._recoveryFailure(this._withFirstRefusal(e), ['reconstruction_timeout', 'attempts_spent'].includes(e.details?.reason) ? e.details.reason : 'driver_failed');
          return;
        }
        // Rust refuses a hidden canvas before counting the attempt, so this one is not spent,
        // even when a loss is also pending.
        const hidden = e?.code === 'RenderRecovering' && e.hint === 'Wait for a visible canvas.';
        if (hidden) --this._recoveryAttempt;
        const context = ENTRY.restoredByEvent ? ENTRY.context(this._canvas) : null;
        // A lost context ends this attempt through the next webglcontextlost event.
        if (ENTRY.restoredByEvent && (!context || context.isContextLost())) return;
        if (hidden) {
          this._restoring = false; this._restore(generation);
          return;
        }
        // No page event announces a valid ratio, so a retry could not wait for one.
        if (e?.code === 'RenderRecovering' && e.hint === 'Invalid device pixel ratio.') {
          this._firstRefusal ??= {code: e.code, path: e.path ?? '', hint: e.hint};
          this._recoveryFailure(this._withFirstRefusal(error('RenderFailed', '', 'Renderer recovery exhausted.')), 'invalid_dpr');
          return;
        }
        if (e?.code === 'RenderRecovering' && (document.hidden || !this._canvas.clientWidth || !this._canvas.clientHeight)) {
          this._restoring = false; this._restore(generation);
          return;
        }
        // Any other refusal or failure spends this attempt, so the episode always ends at the loop top.
        this._firstRefusal ??= {code: e?.code ?? 'DriverFailed', path: e?.path ?? '', hint: e?.hint ?? String(e)};
        continue;
      }
      this._alive(generation);
      if (this._recoveryFailed || !this._recovering || epoch !== this._lossEpoch) return;
      // A pending browser loss is not certified by a successful present.
      const reportedContext = ENTRY.restoredByEvent ? ENTRY.context(this._canvas) : null;
      if (ENTRY.restoredByEvent && (!reportedContext || reportedContext.isContextLost())) return;
      this._publishAdapter();
      // Rust has presented but remains Lost until JS validates and confirms this report.
      try {
        if (report?.presented !== true || report?.generation !== generation || report.level !== ENTRY.level ||
            report.retry_count !== attempt || !Array.isArray(report.replay?.models) || !Array.isArray(report.replay?.warnings) ||
            report.replay.models.length !== entries.filter(([, e]) => e.copy).length ||
            report.replay.warnings.length !== entries.filter(([, e]) => e.outcome).length)
          throw error('RenderFailed', '', 'Incomplete recovery report or frame.');
        const next = new Map();
        const seen = new Set();
        for (const [index, {previous_model, model}] of report.replay.models.entries()) {
          const expected = entries.filter(([, e]) => e.copy)[index];
          if (previous_model !== expected?.[0] || !modelId(model) || seen.has(model) || this._records.has(model))
            throw error('RenderFailed', '', 'Invalid replay model mapping.');
          seen.add(model); next.set(model, expected[1]);
        }
        for (const [index, warning] of report.replay.warnings.entries()) {
          const [id, entry] = entries.filter(([, e]) => e.outcome)[index] ?? [];
          if (warning.code !== 'ModelBytesNotRetained' || warning.path !== '' || !id ||
              !same(warning.details, {model: id, reason: entry.outcome.reason, model_bytes: entry.length,
                retained_bytes: entry.outcome.retainedBytes, limit_bytes: entry.outcome.limitBytes}) ||
              typeof warning.message !== 'string' || typeof warning.hint !== 'string')
            throw error('RenderFailed', '', 'Invalid missing-model warning.');
        }
        if (seen.size + report.replay.warnings.length !== entries.length)
          throw error('RenderFailed', '', 'Incomplete model accounting.');
        const staged = this._stagedEvents;
        // Validation failure is terminal; never recreate an already presented candidate.
        const confirmingContext = ENTRY.restoredByEvent ? ENTRY.context(this._canvas) : null;
        if (ENTRY.restoredByEvent && (!confirmingContext || confirmingContext.isContextLost())) return;
        this._host.confirmRecovery(report);
        this._observeMotion();
        this._stagedEvents = [];
        const ids = report.replay.models.map(pair => pair.model);
        this._acceptedRestore = {retry_count: report.retry_count, level: report.level, replay: report.replay};
        this._replay = {ids, loaded: new Map(), restored: null};
        // Deliver pre-loss loads in their read order; only reported fresh IDs belong to this replay.
        for (const event of staged) if (event.name === 'model.loaded' && !ids.includes(event.payload?.info?.model) && this._records.has(event.payload?.info?.model)) this._deliver(event);
        this._records = next; this._recoveryWarnings = report.replay.warnings;
        this._recovering = false; this._restoring = false; this._restored = false;
        this._loadedEvents.clear(); this._expectedWarnings.clear();
        for (const event of staged) if (event.name === 'model.loaded' && ids.includes(event.payload?.info?.model)) this._emit(event, generation);
        for (const event of staged) if (event.name === 'render.restored') this._emit(event, generation);
        this._schedule(generation);
        return;
      } catch (e) {
        if (generation !== this._generation || this._recoveryFailed || !this._recovering || epoch !== this._lossEpoch) return;
        const context = ENTRY.restoredByEvent ? ENTRY.context(this._canvas) : null;
        // The World became unsafe again during the episode: nothing was published and this
        // attempt is spent. The next attempt's replacement clears the flag; the loop top ends
        // the episode after the third attempt (D-516).
        if (e?.code === 'RenderRecovering' && e.hint === WORLD_UNSAFE_HINT && (!ENTRY.restoredByEvent || (context && !context.isContextLost()))) {
          this._firstRefusal ??= {code: e.code, path: e.path ?? '', hint: e.hint};
          continue;
        }
        if (e?.code === 'RenderRecovering' || (ENTRY.restoredByEvent && (!context || context.isContextLost()))) return;
        this._recoveryFailure(e, 'invalid_recovery_report');
        return;
      }
    }
  }
}

for (const method of ['resize', 'getAttributes', 'setAttributes', 'setInput', 'getCamera', 'setCamera',
  'setFocus', 'setSpin', 'stop', 'subscribeEvents', 'readEvents', 'unsubscribeEvents', 'getGraphics'])
  CinemaViewerElement.prototype[method] = function (input = {}, options) {
    const generation = this._generation;
    return this._enqueue(async () => {
      this._readFailure();
      this._refuseIfRetired();
      if (!(this._host && READABLE_METHODS.includes(method))) await this.ready;
      this._alive(generation);
      if (options?.signal?.aborted) throw error('Cancelled', '', 'Call aborted before admission.');
      if (this._recoveryFailed && !READABLE_METHODS.includes(method)) throw error('RenderFailed', '', 'Renderer recovery failed.');
      if (this._recovering && !READABLE_METHODS.includes(method)) throw error('RenderRecovering', '', 'Wait for restoration.');
      const result = await this._client[method](input, options);
      this._alive(generation);
      if (['setInput', 'setCamera', 'setFocus', 'setSpin', 'stop', 'setAttributes'].includes(method) && result?.status === 'complete' && result.incomplete === false) {
        this._discardPair?.();
        if (this._canvas) this._canvas.style.touchAction = this._host.touchControlsEnabled() === true ? 'none' : 'auto';
      }
      if (!READABLE_METHODS.includes(method)) this._wake(generation);
      return result;
    });
  };

export function defineCinemaViewer() {
  if (!customElements.get('cinema-viewer')) customElements.define('cinema-viewer', CinemaViewerElement);
  else if (customElements.get('cinema-viewer') !== CinemaViewerElement) throw error('VersionSkew', '', 'cinema-viewer is already registered by a different implementation.');
}
