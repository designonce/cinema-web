// Copyright (C) 2026 Admix Pty. Ltd.
// SPDX-License-Identifier: MIT OR Apache-2.0

const DEADLINE_MS = 30000;
const STOP_GRACE_MS = 1000;
const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');

export class StepWorker {
  constructor(base, manifest, makeError) {
    this.base = base;
    this.manifest = manifest;
    this.makeError = makeError;
    this.session = 0;
    this.task = 0;
    this.worker = null;
    this.converter = null;
    this.convert = null;
    this.starting = null;
    this.startupAbort = null;
    this.active = null;
    this.closed = false;
    this.stopping = null;
  }
  failure(code, hint, details = null) { return this.makeError(code, '/source/bytes', hint, details); }
  retire() {
    this.worker?.terminate();
    this.worker = null;
    this.stopping = null;
  }
  close() {
    this.closed = true;
    this.startupAbort?.abort();
    this.active?.reject(this.failure('Cancelled', 'Viewer disconnected.'));
    this.active = null;
    this.retire();
  }
  async checked(path, signal, deadline) {
    const entry = this.manifest.files?.[path];
    if (!entry || !Number.isSafeInteger(entry.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw this.failure('VersionSkew', `Missing worker file identity: ${path}.`);
    let response;
    try {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
      response = await fetch(new URL(path, this.base),
        {cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))])});
      if (!response.ok) throw this.failure('VersionSkew', `Could not fetch ${path}.`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== entry.bytes || await hex(bytes) !== entry.sha256)
        throw this.failure('VersionSkew', `Worker file identity mismatch: ${path}.`);
      return bytes;
    } catch (cause) {
      if (signal.aborted) throw this.failure('Cancelled', 'Load aborted.');
      if (performance.now() >= deadline) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
      if (cause.code) throw cause;
      throw this.failure('VersionSkew', `Could not fetch ${path}.`);
    }
  }
  async start(deadline, signal) {
    if (this.closed) throw this.failure('Cancelled', 'Viewer disconnected.');
    if (this.stopping) await this.stopping;
    if (this.closed || signal.aborted) throw this.failure('Cancelled', 'Load aborted.');
    if (deadline <= performance.now()) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
    if (this.worker || this.convert) return;
    if (this.starting) return this.starting;
    this.starting = this.boot(deadline, signal);
    try { await this.starting; } finally { this.starting = null; }
  }
  async boot(deadline, signal) {
    const identity = this.manifest.worker;
    if (identity?.worker_protocol_version !== 2 || identity.worker_supported_protocol_min !== 2 ||
        identity.worker_supported_protocol_max !== 2)
      throw this.failure('VersionSkew', 'Worker protocol identity mismatch.');
    const root = new URL(this.base);
    if (!this.manifest.files || typeof this.manifest.files !== 'object')
      throw this.failure('VersionSkew', 'Worker inventory is missing.');
    let wasm;
    for (const path of ['kernel-worker.mjs', 'kernel_worker.js', 'kernel-worker.wasm',
      ...Object.keys(this.manifest.files).filter(path => path.startsWith('snippets/'))]) {
      const bytes = await this.checked(path, signal, deadline);
      if (path === 'kernel-worker.wasm') wasm = bytes;
    }
    if (this.closed || signal.aborted) throw this.failure('Cancelled', 'Load aborted.');
    if (deadline <= performance.now()) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
    // A page cannot start a module worker at another origin. A blob bootstrap keeps
    // conversion off the main thread when worker-src permits blob: and module CORS.
    if (root.origin === location.origin) {
      try {
        await this.launch(new URL('kernel-worker.mjs', root), identity, root, deadline, signal, 'worker');
        return;
      } catch (cause) { if (!['WorkerUnavailable', 'WorkerLost'].includes(cause.code)) throw cause; }
    }
    let blob;
    try {
      blob = URL.createObjectURL(new Blob([`import ${JSON.stringify(new URL('kernel-worker.mjs', root).href)};`],
        {type: 'text/javascript'}));
      await this.launch(blob, identity, root, deadline, signal, 'blob-worker');
      return;
    } catch (cause) {
      if (cause.path === '/source/bytes' && !['WorkerUnavailable', 'WorkerLost'].includes(cause.code)) throw cause;
    } finally { if (blob) URL.revokeObjectURL(blob); }
    if (this.closed || signal.aborted) throw this.failure('Cancelled', 'Load aborted.');
    if (deadline <= performance.now()) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
    try {
      const module = await import(new URL('kernel_worker.js', root));
      if (this.closed || signal.aborted) throw this.failure('Cancelled', 'Load aborted.');
      if (deadline <= performance.now()) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
      await module.default({module_or_path: wasm});
      if (typeof module.convert_model_package !== 'function')
        throw this.failure('VersionSkew', 'Worker conversion export missing.');
      this.convert = module.convert_model_package;
      this.converter = 'main-thread';
    } catch (cause) {
      if (cause.path === '/source/bytes') throw cause;
      throw this.failure('VersionSkew', 'Worker WASM could not start.', {cause: String(cause)});
    }
  }
  async launch(url, identity, root, deadline, signal, converter) {
    let worker;
    try { worker = new Worker(url, {type: 'module'}); }
    catch { throw this.failure('WorkerUnavailable', 'The browser blocked the source worker.'); }
    this.worker = worker;
    const session = ++this.session;
    try {
      await new Promise((resolve, reject) => {
        let timer;
        const abort = () => finish(reject, this.failure('Cancelled', 'Load aborted.'));
        const finish = (callback, value) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort); callback(value);
        };
        timer = setTimeout(() => finish(reject, this.failure('WorkerUnavailable', 'Source worker did not start.')),
          Math.min(5000, deadline - performance.now()));
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) { abort(); return; };
        worker.onmessage = ({data}) => {
          if (data?.kind === 'hello' && data.worker_session === session) {
            if (data.identity?.worker_protocol_version !== identity.worker_protocol_version ||
                data.identity.worker_supported_protocol_min !== identity.worker_supported_protocol_min ||
                data.identity.worker_supported_protocol_max !== identity.worker_supported_protocol_max) {
              finish(reject, this.failure('VersionSkew', 'Worker protocol identity mismatch.'));
            } else finish(resolve);
          } else if (data?.kind === 'startup_error') {
            finish(reject, this.failure('VersionSkew', data.message));
          } else if (data?.worker_session === session) this.message(data);
        };
        worker.onerror = () => {
          const failure = this.failure('WorkerLost', 'Source worker stopped unexpectedly.');
          this.active?.reject(failure); this.active = null;
          finish(reject, failure);
          this.retire();
        };
        worker.postMessage({kind: 'init', worker_session: session, identity, base: root.href, files: this.manifest.files});
      });
      if (this.closed || signal.aborted) throw this.failure('Cancelled', 'Load aborted.');
      this.converter = converter;
    } catch (e) { this.retire(); throw e; }
  }
  message(data) {
    const active = this.active;
    if (!active || data.worker_session !== this.session || data.task_id !== active.task || active.signal?.aborted) return;
    if (data.kind === 'progress' && data.stage === 'parse') active.progress('parse');
    else if (data.kind === 'result' && data.bytes instanceof ArrayBuffer) {
      this.active = null; active.progress('validate'); active.resolve(new Uint8Array(data.bytes));
    } else if (data.kind === 'load_error') {
      this.active = null;
      const cause = String(data.message).slice(0, 512);
      active.reject(this.failure('ModelLoadFailed',
        cause.includes('unverified STEP units')
          ? 'STEP units could not be verified. Export with explicit consistent units or supply a checked render package.'
          : 'Model conversion failed.', {cause}));
    }
  }
  async load(bytes, signal, progress, format = 'step') {
    if (signal?.aborted) throw this.failure('Cancelled', 'Load aborted.');
    const started = performance.now();
    progress('worker_start');
    const startup = new AbortController();
    this.startupAbort = startup;
    const abortStartup = () => startup.abort();
    signal?.addEventListener('abort', abortStartup, {once: true});
    const deadline = started + DEADLINE_MS;
    try { await this.start(deadline, startup.signal); }
    finally {
      signal?.removeEventListener('abort', abortStartup);
      if (this.startupAbort === startup) this.startupAbort = null;
    }
    if (signal?.aborted || this.closed) throw this.failure('Cancelled', 'Load aborted.');
    const remaining = DEADLINE_MS - (performance.now() - started);
    if (remaining <= 0) {
      this.retire();
      throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
    }
    if (this.convert) {
      progress('parse');
      let result;
      try { result = this.convert(bytes, format); }
      catch (cause) {
        const message = String(cause).slice(0, 512);
        throw this.failure('ModelLoadFailed', message.includes('unverified STEP units')
          ? 'STEP units could not be verified. Export with explicit consistent units or supply a checked render package.'
          : 'Model conversion failed.', {cause: message});
      }
      if (signal?.aborted || this.closed) throw this.failure('Cancelled', 'Load aborted.');
      if (performance.now() >= deadline) throw this.failure('DeadlineExceeded', 'Source conversion deadline expired.');
      progress('validate');
      return new Uint8Array(result);
    }
    if (this.active) throw this.failure('WorkerUnavailable', 'Source worker is busy.');
    const task = ++this.task;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const finish = (value, failed) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failed) reject(value); else resolve(value);
      };
      const abort = () => {
        this.active = null;
        finish(this.failure('Cancelled', 'Load aborted.'), true);
        worker.postMessage({kind: 'stop', worker_session: this.session, task_id: task});
        // A synchronous parser cannot receive stop until it yields. Never reuse this worker.
        this.stopping = new Promise(done => setTimeout(() => {
          if (this.worker === worker) this.retire();
          done();
        }, STOP_GRACE_MS));
      };
      const timer = setTimeout(() => {
        this.active = null;
        finish(this.failure('DeadlineExceeded', 'Source conversion deadline expired.'), true);
        this.retire();
      }, remaining);
      this.active = {task, signal, progress, resolve: value => finish(value, false), reject: value => finish(value, true)};
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) { abort(); return; }
      const transfer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      worker.postMessage({kind: 'load', worker_session: this.session, task_id: task, format, bytes: transfer}, [transfer]);
    });
  }
}
