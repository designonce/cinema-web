// Copyright (C) 2026 Admix Pty. Ltd.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Private protocol 2: every task and reply carries its worker session and task id.
// The parent owns deadlines and termination; synchronous STEP parsing cannot observe a stop message.
const PROTOCOL = Object.freeze({worker_protocol_version: 2, worker_supported_protocol_min: 2,
  worker_supported_protocol_max: 2});
let session = null;
let convert = null;
const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  byte => byte.toString(16).padStart(2, '0')).join('');

async function checked(base, files, path) {
  const entry = files[path];
  if (!entry || !Number.isSafeInteger(entry.bytes) || !/^[a-f0-9]{64}$/.test(entry.sha256))
    throw new Error(`Missing worker file identity: ${path}`);
  const response = await fetch(new URL(path, base), {cache: 'no-store'});
  if (!response.ok) throw new Error(`Worker file unavailable: ${path}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== entry.bytes || await hex(bytes) !== entry.sha256)
    throw new Error(`Worker file identity mismatch: ${path}`);
  return bytes;
}

self.onmessage = async ({data}) => {
  if (data?.kind === 'init' && session === null) {
    try {
      const {identity, base, files, worker_session} = data;
      if (identity?.worker_protocol_version !== PROTOCOL.worker_protocol_version ||
          identity.worker_supported_protocol_min !== PROTOCOL.worker_supported_protocol_min ||
          identity.worker_supported_protocol_max !== PROTOCOL.worker_supported_protocol_max ||
          !Number.isSafeInteger(worker_session) || worker_session < 1)
        throw new Error('Worker protocol identity mismatch');
      const root = new URL(base);
      await checked(root, files, 'kernel_worker.js');
      const wasm = await checked(root, files, 'kernel-worker.wasm');
      for (const path of Object.keys(files).filter(path => path.startsWith('snippets/')))
        await checked(root, files, path);
      // Fetching the module URL can fetch again; the inventory guards package consistency,
      // not the bytes the browser chooses to execute after this check.
      const module = await import(new URL('kernel_worker.js', root));
      await module.default({module_or_path: wasm});
      convert = module.convert_model_package;
      if (typeof convert !== 'function') throw new Error('Worker conversion export missing');
      session = worker_session;
      self.postMessage({kind: 'hello', worker_session: session, identity: PROTOCOL});
    } catch (cause) {
      self.postMessage({kind: 'startup_error', message: String(cause)});
    }
    return;
  }
  if (session === null || data?.worker_session !== session || !Number.isSafeInteger(data.task_id)) return;
  if (data.kind === 'stop') return;
  if (data.kind !== 'load' || !(data.bytes instanceof ArrayBuffer) || !['step', 'stl', 'obj'].includes(data.format)) return;
  const address = {worker_session: session, task_id: data.task_id};
  self.postMessage({kind: 'progress', ...address, stage: 'parse'});
  try {
    const result = convert(new Uint8Array(data.bytes), data.format);
    const bytes = result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    self.postMessage({kind: 'result', ...address, bytes}, [bytes]);
  } catch (cause) {
    self.postMessage({kind: 'load_error', ...address, message: String(cause)});
  }
};
