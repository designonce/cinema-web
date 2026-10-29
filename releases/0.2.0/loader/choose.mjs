// Copyright (C) 2026 Admix Pty. Ltd.
// SPDX-License-Identifier: MIT OR Apache-2.0

const indexUrl = new URL('../index.json', import.meta.url);
const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

const attempt = (build, reason) => ({
  level: build?.level,
  backend: build?.backend,
  profile: build?.profile,
  reason,
});
const failure = (reason, attempts = []) => ({ok: false, reason, attempts});
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const safePath = value => text(value) && !value.includes('\\') && !value.includes('%') &&
  !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

function validBuild(build) {
  if (!plainObject(build) || !['A', 'B', 'C'].includes(build.level) ||
      !['webgpu', 'webgl2'].includes(build.backend) || !text(build.product) || !text(build.profile) ||
      !Array.isArray(build.input_kinds) || !build.input_kinds.every(text) || !safePath(build.path) ||
      !safePath(build.entry) || !plainObject(build.requires) || !plainObject(build.manifest) ||
      !Number.isSafeInteger(build.manifest.bytes) || !/^[a-f0-9]{64}$/.test(build.manifest.sha256) ||
      !text(build.catalog_hash) || !Number.isSafeInteger(build.protocol_version) ||
      !plainObject(build.render_package_version) ||
      !Number.isSafeInteger(build.render_package_version.major) || build.render_package_version.major < 0 ||
      !Number.isSafeInteger(build.render_package_version.minor) || build.render_package_version.minor < 0 ||
      Object.keys(build.render_package_version).length !== 2 || !plainObject(build.transfer)) return false;
  if (build.backend === 'webgpu' && !plainObject(build.requires.webgpu)) return false;
  if (build.backend === 'webgl2' && (!plainObject(build.requires.webgl2) ||
      !Number.isFinite(build.requires.webgl2.min_samples))) return false;
  return build.path === `${build.product}/${build.profile}`;
}

function validIndex(index) {
  return plainObject(index) && index.index_version === 1 && text(index.artifact_version) &&
    safePath(index.loader) && Array.isArray(index.builds) && index.builds.every(validBuild) &&
    new Set(index.builds.map(build => build.profile)).size === index.builds.length;
}

function timed(work, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
    const abort = () => {
      controller.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve(work(controller.signal)).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  });
}

async function index(timeoutMs, signal) {
  let response;
  try { response = await timed(fetchSignal => fetch(indexUrl, {signal: fetchSignal, cache: 'no-store'}), timeoutMs, signal); }
  catch (error) {
    return {error: signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error?.message === 'timeout' ? 'timeout' : 'fetch_failed'};
  }
  if (!response.ok) return {error: 'fetch_failed'};
  try {
    const value = await timed(() => response.json(), timeoutMs, signal);
    return validIndex(value) ? {value} : {error: 'bad_index'};
  } catch (error) {
    return {error: signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error?.message === 'timeout' ? 'timeout' : 'bad_index'};
  }
}

async function supports(build, timeoutMs, signal) {
  const required = build.requires;
  if (required.secure_context && globalThis.isSecureContext !== true) return 'insecure_context';
  if (required.wasm) {
    if (typeof globalThis.WebAssembly?.compile !== 'function') return 'no_wasm';
    try { await timed(() => globalThis.WebAssembly.compile(emptyWasm), timeoutMs, signal); }
    catch (error) { return signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error?.message === 'timeout' ? 'timeout' : 'wasm_compile_blocked'; }
  }
  if (build.backend === 'webgpu') {
    if (!globalThis.navigator?.gpu?.requestAdapter) return 'unavailable_adapter';
    let adapter;
    try { adapter = await timed(() => globalThis.navigator.gpu.requestAdapter(), timeoutMs, signal); }
    catch (error) { return signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'timeout'; }
    if (!adapter) return 'unavailable_adapter';
    const gpu = required.webgpu;
    if (!plainObject(gpu)) return 'malformed_entry';
    if (Array.isArray(gpu.features) && !gpu.features.every(feature => adapter.features?.has(feature))) return 'missing_feature';
    if (plainObject(gpu.limits) && !Object.entries(gpu.limits).every(([name, value]) => Number.isFinite(value) && adapter.limits?.[name] >= value)) return 'insufficient_limit';
  }
  if (build.backend === 'webgl2') {
    const requirement = required.webgl2;
    if (!plainObject(requirement) || !Number.isFinite(requirement.min_samples)) return 'malformed_entry';
    const canvas = globalThis.document?.createElement?.('canvas');
    const context = canvas?.getContext?.('webgl2');
    if (!context) return 'unavailable_webgl2';
    const samples = context.getParameter(context.MAX_SAMPLES);
    const lose = context.getExtension?.('WEBGL_lose_context');
    lose?.loseContext?.();
    if (!Number.isFinite(samples) || samples < requirement.min_samples) return 'insufficient_limit';
  }
  return null;
}

/** Selects one compatible release build without importing its viewer. */
export async function chooseBuild({inputKind = 'render-package', exclude = [], timeoutMs = 5000, signal} = {}) {
  if (!Array.isArray(exclude) || !Number.isFinite(timeoutMs) || timeoutMs < 0) return failure('bad_options');
  const loaded = await index(timeoutMs, signal);
  if (loaded.error) return failure(loaded.error);
  const attempts = [];
  for (const build of loaded.value.builds) {
    if (exclude.includes(build.profile)) { attempts.push(attempt(build, 'excluded')); continue; }
    if (!build.input_kinds.includes(inputKind)) { attempts.push(attempt(build, 'unsupported_input')); continue; }
    const reason = await supports(build, timeoutMs, signal);
    if (reason) {
      attempts.push(attempt(build, reason));
      if (reason === 'aborted') return failure('aborted', attempts);
      continue;
    }
    const base = new URL(`${build.path}/`, indexUrl);
    return {ok: true, build: {...build, viewerUrl: new URL(build.entry, base).href, manifestUrl: new URL('manifest.json', base).href,
      version: loaded.value.artifact_version}, attempts};
  }
  return failure(attempts.some(value => value.reason === 'timeout') ? 'timeout' : 'unsupported', attempts);
}

/** Selects a build once, imports that exact viewer, and registers its custom element. */
export async function loadViewer(options = {}) {
  const selected = await chooseBuild(options);
  if (!selected.ok) return selected;
  try {
    const viewer = await import(selected.build.viewerUrl);
    if (typeof viewer.defineCinemaViewer !== 'function') throw new Error('missing defineCinemaViewer');
    viewer.defineCinemaViewer();
    return {...selected, loaded: true};
  } catch (error) {
    return {...selected, ok: false, reason: 'viewer_load_failed', error};
  }
}
