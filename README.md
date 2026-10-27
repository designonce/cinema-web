# Cinema web releases

This repository holds published Cinema web releases. The index lists the groups and variants that a
release contains.

Cinema uses three levels:

- A is native-only.
- B uses WebGPU only when the index lists it.
- C uses WebGL2.

Version 0.2.2 contains raw B at `embed/web-basic-webgpu` and raw C at `embed/web-basic-webgl2`. It
also contains the gzip C variant at `embed/web-basic-webgl2.gzip`. Each group has its own manifest
and runtime files.

## URLs

The browser host is `https://designonce.github.io/cinema-web/`. Use an exact release URL in an
embedding page:

```text
https://designonce.github.io/cinema-web/releases/<version>/loader/choose.mjs
```

The changing pointer is `https://designonce.github.io/cinema-web/channels/latest.json`. It names the
newest published version. Use an exact version for repeatable bytes.

Do not use raw GitHub as a module host. It does not provide the supported browser delivery.

## Use in a browser

This example loads a render package from the page origin. Replace `<version>` and `sample.rpkg`.

```html
<style>
  cinema-viewer { display: block; width: 640px; height: 480px; }
</style>

<script type="module">
  import { loadViewer } from 'https://designonce.github.io/cinema-web/releases/<version>/loader/choose.mjs';

  const result = await loadViewer({
    inputKind: 'render-package',
  });
  console.log({
    ok: result.ok,
    loaded: result.loaded,
    variant: result.build?.variant,
    attempts: result.attempts,
  });
  if (!result.ok) throw new Error(`loadViewer failed: ${result.reason}`);

  const viewer = document.createElement('cinema-viewer');
  viewer.setAttribute('scene-mode', 'basic');
  viewer.addEventListener('model-loaded', event => console.log('model-loaded', event.detail));
  document.body.append(viewer);

  try {
    await viewer.ready;
  } catch (error) {
    console.error(error, viewer.diagnostics);
    throw error;
  }

  const response = await fetch('./sample.rpkg', {cache: 'no-store'});
  if (!response.ok) throw new Error(`sample.rpkg failed: HTTP ${response.status}`);

  try {
    const model = await viewer.models.load({
      source: {bytes: new Uint8Array(await response.arrayBuffer())},
    });
    console.log({
      status: model.status,
      incomplete: model.incomplete,
      data: model.data, // Includes the model ID.
      warnings: model.warnings,
    });
    if (model.status !== 'complete' || model.incomplete !== false)
      console.error('The model did not load completely.', viewer.diagnostics);
  } catch (error) {
    console.error(error, viewer.diagnostics);
    throw error;
  }
</script>
```

The loader chooses B on a qualified WebGPU device. Otherwise, it tries C. To force B or C, use one
of these calls with the same `loadViewer` import:

```js
const result = await loadViewer({profile: 'web-basic-webgpu'}); // Only B.
if (!result.ok) console.log(result.reason, result.attempts);
```

```js
const result = await loadViewer({profile: 'web-basic-webgl2'}); // Only C.
if (!result.ok) console.log(result.reason, result.attempts);
```

To keep automatic selection but omit B, use `exclude`:

```js
const result = await loadViewer({exclude: ['web-basic-webgpu']});
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

B can refuse a device with `unavailable_adapter`, `fallback_adapter`, `missing_feature`,
`insufficient_limit`, or `request_device_failed`. Other probe reasons include `insecure_context`,
`no_wasm`, `wasm_compile_blocked`, `timeout`, and `aborted`. Read `result.attempts` to see why B was
refused. A forced B request does not try C. B currently draws opaque scenes only. Transparency,
section caps, capture, and selection highlight are not available on B. Firefox on Linux has no
WebGPU. Use C in that browser.

`model-loaded` reports the completed model load. Use `viewer.getGraphics()` for graphics
diagnostics. This example does not prove that a canvas has drawn pixels.

Each source-enabled group has `kernel_execution`, a profile, and `default_variant`. Package-only
groups have no kernel mode. The loader defaults `kernelExecution` to `worker` and uses the group's
default when `variant` is absent. It does not change mode or variant after a failure.

When source packages are indexed, request `kernelExecution: 'worker'` for worker STEP. Request
`kernelExecution: 'main'` for bundled STEP. A package-only group can be selected with either mode.
An exact profile selects its source-enabled mode.

A listed raw variant can later be absent from Pages. An explicit request then fails as unavailable
or fetch failure. The loader does not select Brotli or another mode automatically.

The loader selects a group before it imports the viewer. After import starts, it does not select
another group. A `WorkerUnavailable` error from the viewer passes through unchanged.

## Page requirements

The embedding page must run in a secure context. Its CSP must allow the release host in `script-src`
and `connect-src`. The browser must support the selected backend.

Same-origin static hosts, localhost hosts, and desktop bundles can use a release if they serve
modules with a JavaScript module MIME type. They must permit WASM compilation. The WebGL2 profile
requires WebGL2 with at least four samples.

A publication check proves that release URLs and hashes match. It does not prove browser, CSP, GPU,
or webview support.

## Use in an artifact

A page inside a claude.ai artifact cannot fetch or import from GitHub Pages. The artifact CSP blocks
those requests. A normal secure host can import Pages when its CSP permits the Pages host in both
`script-src` and `connect-src`.

An agent with a shell and a tool that publishes supporting files can publish the gzip variant on the
artifact origin. An agent with web chat only cannot use this procedure. Normal Pages hosting does
not need gzip or an artifact.

### Prepare the files

Set `VERSION` to one published version. Keep this value unchanged for the artifact.

```sh
VERSION='<version>'
ROOT="releases/$VERSION"
BASE="https://designonce.github.io/cinema-web/$ROOT"
```

Download these files from `$BASE`:

- `index.json` and `loader/choose.mjs`.
- `embed/web-basic-webgl2.gzip/manifest.json`.
- Every runtime file declared by that manifest, including `viewer.mjs`, `client.mjs`,
  `renderer_webgl2.js`, `generated/web-basic-webgl2/catalog.json`, and each declared file in
  `snippets/`.
- `embed/web-basic-webgl2.gzip/renderer-webgl2.wasm.gz.wasm`.

Read the manifest before you download the runtime files. A future release can declare additional
paths. Do not hardcode this list as the complete runtime list.

Use the gzip variant's `files` records to select physical paths. The logical WASM key is
`renderer-webgl2.wasm`, but its physical path is `renderer-webgl2.wasm.gz.wasm`.

Make sure that the files are correct on the shell before publication. Compare the gzip variant's
manifest bytes and SHA-256 with `index.json`. Then compare each downloaded physical file with its
`stored.bytes` and `stored.sha256` record. The following Python command performs both comparisons
for a downloaded release tree:

```sh
python3 - "$ROOT" <<'PY'
import hashlib, json, pathlib, sys

root = pathlib.Path(sys.argv[1])
index = json.loads((root / 'index.json').read_text())
variant = next(
    variant
    for build in index['builds']
    if build['profile'] == 'web-basic-webgl2'
    for variant in build['variants']
    if variant['id'] == 'gzip'
)
base = root / variant['path']
manifest = base / 'manifest.json'

def identity(path):
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest()

assert identity(manifest) == (variant['manifest']['bytes'], variant['manifest']['sha256'])
for logical, record in variant['files'].items():
    assert identity(base / record['path']) == (record['stored']['bytes'], record['stored']['sha256']), logical
PY
```

Publish the files at the same relative paths under `releases/<version>/`. Publish them as
same-origin supporting files. Do not publish the raw 41,489,584-byte WASM file.

The compressed WASM filename already ends in `.wasm`. Do not rename it. The loader fetches it as
bytes and decompresses it. It does not import or compile the compressed bytes. Make sure that the
published response has no automatic `Content-Encoding: gzip`.

Keep each binary file at or below 15 MB. Keep each text file at or below 16 MB. Keep one publish at
or below 64 MB.

Publish a small render package as base64 in `sample.rpkg.json`. Some artifact tools reject `.rpkg`
and `.bin` files. The JSON file can contain `{"base64":"..."}`.

### Artifact page

This page imports the loader from its own origin. It creates the element before it connects it.

```html
<style>
  cinema-viewer { display: block; width: 640px; height: 480px; }
</style>

<script type="module">
  import { loadViewer } from './releases/<version>/loader/choose.mjs';

  const result = await loadViewer({
    profile: 'web-basic-webgl2',
    variant: 'gzip',
    inputKind: 'render-package',
    createElement: true,
  });
  console.log({
    ok: result.ok,
    loaded: result.loaded,
    variant: result.build?.variant,
    attempts: result.attempts,
  });
  if (!result.ok) throw new Error(`loadViewer failed: ${result.reason}`);

  const viewer = result.viewer;
  viewer.setAttribute('scene-mode', 'basic');
  viewer.addEventListener('model-loaded', event => console.log('model-loaded', event.detail));
  document.body.append(viewer);

  try {
    await viewer.ready;
    const packageFile = await fetch('./sample.rpkg.json', {cache: 'no-store'});
    if (!packageFile.ok) throw new Error(`sample.rpkg.json failed: HTTP ${packageFile.status}`);
    const {base64} = await packageFile.json();
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const model = await viewer.models.load({source: {bytes}});
    console.log({status: model.status, incomplete: model.incomplete, data: model.data, warnings: model.warnings});
  } catch (error) {
    console.error(error, viewer.diagnostics);
    throw error;
  }
</script>
```

Browser CSP and GPU policies still decide if startup succeeds.

## Measured support

These are observations, not guarantees for every browser or artifact.

- In a claude.ai artifact with Chrome 155, the gzip variant loaded and WebGL2 ran on the GPU.
- In that artifact, native `DecompressionStream('brotli')` was unavailable. Gzip worked.
- The raw release drew in headless Chrome 152 with SwiftShader flags.
- The raw release drew in Firefox 158 with headless WebGL2 forced.

## Index and pointer formats

Each release has `releases/<version>/index.json`. It is canonical JSON with `index_version`,
`artifact_version`, `loader`, and `builds`.

A group has its logical identity, backend requirements, `default_variant`, and variants.
Source-enabled groups also have `kernel_execution`. Package-only groups do not. The raw variant
directory is the group's path (`embed/<profile>`). Every other variant is a sibling directory
(`embed/<profile>.<variant-id>`). A variant has its runtime, encoding, WASM requirement, package
path, entry, manifest identity, transfer report, and stored and decoded file identities.

`channels/latest.json` is a discovery pointer. It is not a fixed dependency.

The loader uses these selection reason codes:

- `aborted`
- `bad_index`
- `bad_options`
- `excluded`
- `fallback_adapter`
- `fetch_failed`
- `gzip_unavailable`
- `insecure_context`
- `insufficient_limit`
- `missing_feature`
- `no_wasm`
- `request_device_failed`
- `timeout`
- `unavailable_adapter`
- `unavailable_webgl2`
- `unsupported`
- `unsupported_input`
- `variant_unavailable`
- `viewer_load_failed`
- `wasm_compile_blocked`
- `worker_unavailable`

`WorkerUnavailable` is separate: `loadViewer` returns it when the selected viewer module reports
that its worker cannot be registered. It is not the `worker_unavailable` selection reason, which
means the browser cannot provide a required worker before the viewer is loaded.

## npm delivery

`@designonce/cinema-web@0.2.2` contains the release index, loader, and both build directories.
Import `loadViewer` from `@designonce/cinema-web` to select a build. Import
`@designonce/cinema-web/webgpu` or `@designonce/cinema-web/webgl2` to use a viewer directly. Keep
the package tree intact on a static host so relative URLs and SHA-256 checks work.
