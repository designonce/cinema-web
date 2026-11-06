// Copyright (C) 2026 Admix Pty. Ltd.
// SPDX-License-Identifier: MIT OR Apache-2.0

const indexUrl = new URL('../index.json', import.meta.url);
const emptyWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const path = value => text(value) && !value.includes('\\') && !value.includes('%') && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..');
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(key => key in value);
const attempt = (build, reason) => ({level: build?.level, backend: build?.backend, profile: build?.profile, reason});
const failure = (reason, attempts = []) => ({ok: false, reason, attempts});
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

function validVariant(value) {
  if (!keys(value, ['id', 'runtime', 'encoding', 'requires', 'path', 'entry', 'manifest', 'transfer', 'files']) ||
      !text(value.id) || !['wasm', 'js'].includes(value.runtime) || !['raw', 'gzip', 'br'].includes(value.encoding) ||
      !keys(value.requires, ['wasm']) || typeof value.requires.wasm !== 'boolean' || value.requires.wasm !== (value.runtime === 'wasm') ||
      !path(value.path) || !path(value.entry) || !keys(value.manifest, ['bytes', 'sha256']) || !integer(value.manifest.bytes) || !hash(value.manifest.sha256) ||
      !object(value.transfer) || !object(value.files)) return false;
  return Object.values(value.files).every(file => keys(file, ['path', 'stored', 'decoded']) && path(file.path) &&
    ['stored', 'decoded'].every(kind => keys(file[kind], ['bytes', 'sha256']) && integer(file[kind].bytes) && hash(file[kind].sha256)) &&
    (value.encoding !== 'raw' || file.stored.bytes === file.decoded.bytes && file.stored.sha256 === file.decoded.sha256)) &&
    (value.encoding !== 'gzip' || value.files['renderer-webgl2.wasm']?.path === 'renderer-webgl2.wasm.gz.wasm');
}

function validBuild(build) {
  if (!object(build) || !Array.isArray(build.input_kinds)) return false;
  const sourceEnabled = build.input_kinds.includes('step');
  const expected = ['product', 'profile', 'level', 'backend', 'input_kinds', 'catalog_hash', 'protocol_version', 'render_package_version', 'path', 'requires', 'default_variant', 'variants'];
  if (sourceEnabled) expected.push('kernel_execution');
  if (!keys(build, expected) ||
      !text(build.product) || !text(build.profile) || !['B', 'C'].includes(build.level) ||
      !['webgpu', 'webgl2'].includes(build.backend) || sourceEnabled && !['main', 'worker'].includes(build.kernel_execution) ||
      !build.input_kinds.every(text) || !text(build.catalog_hash) || !integer(build.protocol_version) ||
      !keys(build.render_package_version, ['major', 'minor']) || !integer(build.render_package_version.major) || !integer(build.render_package_version.minor) ||
      !path(build.path) || build.path !== `${build.product}/${build.profile}` || !text(build.default_variant) ||
      !Array.isArray(build.variants) || !build.variants.length || !build.variants.every(validVariant)) return false;
  if (new Set(build.variants.map(value => value.id)).size !== build.variants.length || !build.variants.some(value => value.id === build.default_variant)) return false;
  if (build.level === 'B' && build.backend !== 'webgpu' || build.level === 'C' && build.backend !== 'webgl2') return false;
  const required = build.backend === 'webgpu' ? ['secure_context', 'worker', 'webgpu'] : ['secure_context', 'worker', 'webgl2'];
  if (!keys(build.requires, required) || build.requires.secure_context !== true || build.requires.worker !== (build.kernel_execution === 'worker')) return false;
  if (build.backend === 'webgpu') return keys(build.requires.webgpu, ['features', 'limits']) && Array.isArray(build.requires.webgpu.features) &&
    build.requires.webgpu.features.every(text) && new Set(build.requires.webgpu.features).size === build.requires.webgpu.features.length &&
    object(build.requires.webgpu.limits) && Object.values(build.requires.webgpu.limits).every(integer);
  return keys(build.requires.webgl2, ['min_samples']) && Number.isSafeInteger(build.requires.webgl2.min_samples) && build.requires.webgl2.min_samples > 0;
}

function validIndex(value) {
  return keys(value, ['artifact_version', 'builds', 'index_version', 'loader']) && value.index_version === 1 && text(value.artifact_version) && path(value.loader) &&
    Array.isArray(value.builds) && value.builds.every(validBuild) && new Set(value.builds.map(build => build.profile)).size === value.builds.length &&
    new Set(value.builds.map(build => build.path)).size === value.builds.length;
}

function timed(work, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(work).then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  });
}
const reason = (error, signal, other) => signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error?.message === 'timeout' ? 'timeout' : other;

async function index(timeoutMs, signal) {
  let response;
  try { response = await timed(() => fetch(indexUrl, {cache: 'no-store'}), timeoutMs, signal); }
  catch (error) { return {error: reason(error, signal, 'fetch_failed')}; }
  if (!response.ok) return {error: 'fetch_failed'};
  try { const value = await timed(() => response.json(), timeoutMs, signal); return validIndex(value) ? {value} : {error: 'bad_index'}; }
  catch (error) { return {error: reason(error, signal, 'bad_index')}; }
}

async function supports(build, variant, timeoutMs, signal, allowFallbackAdapter) {
  if (build.requires.secure_context && globalThis.isSecureContext !== true) return 'insecure_context';
  if (build.requires.worker && typeof globalThis.Worker !== 'function') return 'worker_unavailable';
  if (variant.requires.wasm) {
    if (typeof globalThis.WebAssembly?.compile !== 'function') return 'no_wasm';
    try { await timed(() => globalThis.WebAssembly.compile(emptyWasm), timeoutMs, signal); }
    catch (error) { return reason(error, signal, 'wasm_compile_blocked'); }
  }
  if (build.backend === 'webgpu') {
    if (!globalThis.navigator?.gpu?.requestAdapter) return 'unavailable_adapter';
    let adapter;
    try { adapter = await timed(() => globalThis.navigator.gpu.requestAdapter(), timeoutMs, signal); }
    catch (error) { return reason(error, signal, 'unavailable_adapter'); }
    if (!adapter) return 'unavailable_adapter';
    let fallback;
    try { fallback = adapter.info.isFallbackAdapter; } catch (_) { fallback = undefined; }
    if (!allowFallbackAdapter && fallback !== false) return 'fallback_adapter';
    const gpu = build.requires.webgpu;
    if (!gpu.features.every(feature => adapter.features?.has(feature))) return 'missing_feature';
    if (!Object.entries(gpu.limits).every(([name, value]) => adapter.limits?.[name] >= value)) return 'insufficient_limit';
    let device;
    try {
      const pending = Promise.resolve(adapter.requestDevice({requiredFeatures: [], requiredLimits: {}}));
      pending.then(value => { device = value; value?.destroy?.(); }, () => {});
      const probe = await timed(() => pending, timeoutMs, signal);
      if (!probe) return 'request_device_failed';
    } catch (error) { return reason(error, signal, 'request_device_failed'); }
  } else {
    const canvas = globalThis.document?.createElement?.('canvas');
    const context = canvas?.getContext?.('webgl2');
    if (!context) return 'unavailable_webgl2';
    const samples = context.getParameter(context.MAX_SAMPLES);
    context.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    if (!Number.isFinite(samples) || samples < build.requires.webgl2.min_samples) return 'insufficient_limit';
  }
  return null;
}

/** Selects one compatible release build without importing its viewer. */
export async function chooseBuild(options = {}) {
  if (!object(options)) return failure('bad_options');
  const {inputKind = 'render-package', profile, variant, exclude = [], timeoutMs = 5000, signal, allowFallbackAdapter = false} = options;
  const suppliedMode = Object.hasOwn(options, 'kernelExecution');
  const kernelExecution = suppliedMode ? options.kernelExecution : 'worker';
  if (!text(inputKind) || profile !== undefined && !text(profile) || variant !== undefined && !text(variant) || !Array.isArray(exclude) || !exclude.every(text) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 0 || signal !== undefined && (!object(signal) || typeof signal.aborted !== 'boolean') || typeof allowFallbackAdapter !== 'boolean' ||
      suppliedMode && !['main', 'worker'].includes(kernelExecution)) return failure('bad_options');
  const loaded = await index(timeoutMs, signal);
  if (loaded.error) return failure(loaded.error);
  let builds = loaded.value.builds;
  if (profile !== undefined) {
    const chosen = builds.find(build => build.profile === profile);
    if (!chosen) return failure('bad_options');
    if (suppliedMode && chosen.kernel_execution !== undefined && kernelExecution !== chosen.kernel_execution) return failure('bad_options');
    builds = [chosen];
  } else builds = builds.filter(build => build.kernel_execution === undefined || build.kernel_execution === kernelExecution);
  const attempts = [];
  for (const build of builds.sort((left, right) => left.level.localeCompare(right.level))) {
    if (exclude.includes(build.profile)) { attempts.push(attempt(build, 'excluded')); continue; }
    if (!build.input_kinds.includes(inputKind)) { attempts.push(attempt(build, 'unsupported_input')); continue; }
    const selectedVariant = build.variants.find(value => value.id === (variant ?? build.default_variant));
    if (!selectedVariant) { attempts.push(attempt(build, 'variant_unavailable')); continue; }
    const supported = await supports(build, selectedVariant, timeoutMs, signal, allowFallbackAdapter);
    if (supported) { attempts.push(attempt(build, supported)); if (supported === 'aborted') return failure('aborted', attempts); continue; }
    const base = new URL(`${selectedVariant.path}/`, indexUrl);
    return {ok: true, build: {...build, variant: selectedVariant, viewerUrl: new URL(selectedVariant.entry, base).href,
      manifestUrl: new URL('manifest.json', base).href, version: loaded.value.artifact_version}, attempts};
  }
  return failure(attempts.some(value => value.reason === 'timeout') ? 'timeout' : attempts.some(value => value.reason === 'variant_unavailable') ? 'variant_unavailable' : 'unsupported', attempts);
}

/** Selects a build once, imports that exact viewer, and registers its custom element. */
export async function loadViewer(options = {}) {
  if (!object(options)) return failure('bad_options');
  const {createElement = false, ...selectionOptions} = options;
  if (typeof createElement !== 'boolean') return failure('bad_options');
  const selected = await chooseBuild(selectionOptions);
  if (!selected.ok) return selected;
  const variant = selected.build.variant;
  if (variant.encoding === 'gzip' && !createElement) return {...selected, ok: false, reason: 'bad_options'};
  if (variant.encoding === 'gzip') {
    try { new DecompressionStream('gzip'); }
    catch { return {...selected, ok: false, reason: 'gzip_unavailable'}; }
  }
  try {
    const module = await import(selected.build.viewerUrl);
    if (typeof module.defineCinemaViewer !== 'function') throw new Error('missing defineCinemaViewer');
    module.defineCinemaViewer();
    if (!createElement) return {...selected, loaded: true};
    const viewer = document.createElement('cinema-viewer');
    viewer.assetBase = new URL('./', selected.build.manifestUrl);
    if (selectionOptions.allowFallbackAdapter === true && selected.build.level === 'B')
      viewer.setAttribute('allow-fallback-adapter', '');
    if (variant.encoding === 'gzip') {
      const file = variant.files['renderer-webgl2.wasm'];
      viewer.wasmBytes = async signal => {
        const response = await fetch(new URL(file.path, selected.build.manifestUrl), {signal, cache: 'no-store'});
        if (!response.ok) throw new Error(`http_${response.status}`);
        const stored = await response.arrayBuffer();
        if (stored.byteLength !== file.stored.bytes || await digest(stored) !== file.stored.sha256) throw new Error('stored identity');
        const decoded = new Blob([stored]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(decoded).arrayBuffer();
      };
    }
    return {...selected, loaded: true, viewer};
  } catch (error) {
    if (error?.name === 'WorkerUnavailable' || error?.code === 'WorkerUnavailable') return {...selected, ok: false, reason: 'WorkerUnavailable', error};
    return {...selected, ok: false, reason: 'viewer_load_failed', error};
  }
}
