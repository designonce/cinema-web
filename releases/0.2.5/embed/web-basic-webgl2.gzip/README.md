<!-- Copyright (C) 2026 Admix Pty. Ltd.
SPDX-License-Identifier: MIT OR Apache-2.0 -->

# @designonce/cinema-web

Version 0.2.5 includes worker-enabled B (WebGPU) and C (WebGL2), plus package-only builds. The
package contains the same compressed release tree as Pages. Serve the entire package as static
files. The loader reads `index.json` beside its `loader/` folder. Each viewer reads its own
`manifest.json` and checks the SHA-256 of its runtime files. Do not bundle these modules without
also copying their directories and preserving their URLs.

```js
import {loadViewer, chooseBuild} from '@designonce/cinema-web';
const result = await loadViewer({inputKind: 'render-package', createElement: true});
if (!result.ok) throw new Error(result.reason);
console.log(result.build.profile); // B on a qualified WebGPU device, else C.
```

Use these examples with the same import. Each example selects only one build:

```js
const result = await loadViewer({profile: 'web-basic-webgpu', createElement: true}); // Force B.
if (!result.ok) console.log(result.reason, result.attempts);
```

```js
const result = await loadViewer({profile: 'web-basic-webgl2', createElement: true}); // Force C.
if (!result.ok) console.log(result.reason, result.attempts);
```

For software-adapter startup diagnostics, Chrome accepts these flags (testing only). Headless wgpu
runs are not rendering validation; verify B rendering in a real browser.

```text
--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-webgpu-adapter=swiftshader --enable-skia-graphite --skia-graphite-dawn-backend=swiftshader
```

Then opt in when you load the published viewer:

```js
const result = await loadViewer({profile: 'web-basic-webgpu', createElement: true, allowFallbackAdapter: true});
if (!result.ok) throw new Error(result.reason);
document.body.append(result.viewer);
await result.viewer.ready;
console.log(result.viewer.diagnostics.adapter.is_fallback_adapter); // true on SwiftShader.
```

If you import the B viewer directly, set `allow-fallback-adapter` on `<cinema-viewer>` before you
connect it. Without this option or attribute, B refuses a software adapter. To force C, use
`profile: 'web-basic-webgl2'`.

To load a model file at either level, choose a worker build and pass its bytes:

```js
const file = document.querySelector('input[type=file]').files[0];
const extension = file.name.toLowerCase().split('.').pop();
const format = {stp: 'step', step: 'step', stl: 'stl', obj: 'obj', rpkg: 'render-package'}[extension];
if (!format) throw new Error('Choose STEP, STL, OBJ or a render package');
const selected = await loadViewer({inputKind: format, kernelExecution: 'worker', createElement: true});
// To require B or C instead, set profile to 'web-step-webgpu' or 'web-step-webgl2'.
if (!selected.ok) throw new Error(JSON.stringify(selected.attempts));
document.body.append(selected.viewer);
await selected.viewer.ready;
const result = await selected.viewer.models.load({source: {bytes: file}, format, label: file.name});
if (result.status !== 'complete' || result.incomplete) throw new Error(JSON.stringify(result));
```

Set `inputKind` to the file's format (`step`, `stl`, `obj`, or `render-package`) when selecting a
build. STEP and render packages can be detected from bytes; STL may be detected from its header; OBJ
requires an explicit format. The worker reads only the formats golf supports: STEP, ASCII or binary
STL, and OBJ. A malformed supported file raises `ModelLoadFailed` at `/source/bytes`; unknown
formats raise `UnsupportedFormat` at `/format`. Both B and C viewers start a checked Worker on the
first source load; package bytes do not start it. Serve the entire checked build directory on the
same origin for a module worker, or permit `worker-src blob:` for a blob worker. If workers are
blocked, conversion runs on the page and blocks the UI. A golf WASM trap can stop the page. The load
result reports `converter` as `worker`, `blob-worker`, or `main-thread`. Main-thread conversion is
synchronous: cancellation and deadlines can reject the result only after conversion returns. Asset
or protocol mismatches raise `VersionSkew`; they never select a fallback. A running worker's
conversion failure is not replayed on the page. Cross-origin delivery still requires CORS and CSP
permission for the module and asset host; fallback cannot bypass those policies. Direct imports
`@designonce/cinema-web/webgpu` and `@designonce/cinema-web/webgl2` include the worker, but do not
probe devices or select another build. Keep every `embed/` directory intact.

The loader reports B refusals in `result.attempts`. These include `unavailable_adapter`,
`fallback_adapter`, `missing_feature`, `insufficient_limit`, and `request_device_failed`. It can
also report `insecure_context`, `no_wasm`, `wasm_compile_blocked`, `timeout`, or `aborted`. If B
fails a probe, the loader tries C. After the viewer import starts, it does not try another build.

B currently draws opaque scenes only. Transparency, section caps, capture, and selection highlight
are not available on B. Firefox on Linux has no WebGPU. Use C in that browser.

## Canvas right-click menu

The default `context-menu="camera"` lets bound right-button camera drags work even when the browser
opens a menu on press. It cancels the canvas's native menu for that chord and sends one
noncancelable `cinema-viewer-contextmenu` event on a short right click. The event's `detail` has
release canvas CSS pixels `x`, `y` and the `ctrl`, `shift`, `alt`, `meta` keys. Show your own menu
from this event if needed. Keyboard menus, unbound chords, controls-off viewers and content outside
the canvas keep their native behavior.

Set `context-menu="browser"` or `viewer.contextMenu = 'browser'` to keep the native menu instead (a
press-time menu can interrupt a drag). A property set before first connection wins over the initial
attribute; later valid property and attribute edits win in time order, including across disconnects.
Removing the attribute resets to `camera`. Invalid attribute values warn without changing the
current setting; invalid property values throw `InvalidValue`. Firefox may show Shift+right-click's
menu without a DOM `contextmenu` event, which the viewer cannot prevent.
