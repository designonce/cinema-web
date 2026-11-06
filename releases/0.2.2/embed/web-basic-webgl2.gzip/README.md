<!-- Copyright (C) 2026 Admix Pty. Ltd.
SPDX-License-Identifier: MIT OR Apache-2.0 -->

# @designonce/cinema-web

Version 0.2.2 includes B (WebGPU) and C (WebGL2). The package contains the same release tree as
Pages. Serve the entire package as static files. The loader reads `index.json` beside its `loader/`
folder. Each viewer reads its own `manifest.json` and checks the SHA-256 of its runtime files. Do
not bundle these modules without also copying their directories and preserving their URLs.

```js
import {loadViewer, chooseBuild} from '@designonce/cinema-web';
const result = await loadViewer({inputKind: 'render-package'});
if (!result.ok) throw new Error(result.reason);
console.log(result.build.profile); // B on a qualified WebGPU device, else C.
```

Use these examples with the same import. Each example selects only one build:

```js
const result = await loadViewer({profile: 'web-basic-webgpu'}); // Force B.
if (!result.ok) console.log(result.reason, result.attempts);
```

```js
const result = await loadViewer({profile: 'web-basic-webgl2'}); // Force C.
if (!result.ok) console.log(result.reason, result.attempts);
```

To test B without a GPU, run headless Chrome with these flags (testing only):

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

To import a viewer directly, use `@designonce/cinema-web/webgpu` or `@designonce/cinema-web/webgl2`
and call `defineCinemaViewer()`. A direct import does not probe the device or select another build.
Keep `embed/web-basic-webgpu/` and `embed/web-basic-webgl2/` intact.

The loader reports B refusals in `result.attempts`. These include `unavailable_adapter`,
`fallback_adapter`, `missing_feature`, `insufficient_limit`, and `request_device_failed`. It can
also report `insecure_context`, `no_wasm`, `wasm_compile_blocked`, `timeout`, or `aborted`. If B
fails a probe, the loader tries C. After the viewer import starts, it does not try another build.

B currently draws opaque scenes only. Transparency, section caps, capture, and selection highlight
are not available on B. Firefox on Linux has no WebGPU. Use C in that browser.
