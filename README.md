# Cinema web releases

This repository holds published Cinema web releases. The index lists the groups and variants that a
release contains.

Cinema uses three levels:

- A is native-only.
- B uses WebGPU only when the index lists it.
- C uses WebGL2.

Currently, releases publish only the raw C `render-package` entry: `embed/web-basic-webgl2`.

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

```html
<cinema-viewer scene-mode="basic"></cinema-viewer>

<script type="module">
  import { loadViewer } from 'https://designonce.github.io/cinema-web/releases/<version>/loader/choose.mjs';

  const result = await loadViewer({
    profile: 'web-basic-webgl2',
    variant: 'raw', // Optional. The group default is used when this is absent.
  });
  console.table(result.attempts.map(({ level, backend, reason }) => ({ level, backend, reason })));
</script>
```

Each source-enabled group has `kernel_execution`, a profile, and `default_variant`; package-only
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

A publication check proves that release URLs and hashes match. It does not prove browser, CSP, GPU,
or webview support.

## Use from an agent

Do not use claude.ai artifacts for Cinema web releases. Their CSP blocks scripts and fetches from
GitHub hosts.

For CLI use, download an exact release index and the selected variant manifest. Download each
declared runtime file without changing its bytes. Keep the release layout and serve it on localhost.

For desktop apps and webviews, bundle the selected variant directory and `loader/choose.mjs` on one
origin. Run the loader probe before you offer the viewer.

For headless browser or CI use, use the index, manifest, and SHA-256 values for delivery checks. Run
browser probes in the target browser.

## Index and pointer formats

Each release has `releases/<version>/index.json`. It is canonical JSON with `index_version`,
`artifact_version`, `loader`, and `builds`.

A group has its logical identity, backend requirements, `default_variant`, and variants.
Source-enabled groups also have `kernel_execution`; package-only groups do not. The raw variant
directory is the group's path (`embed/<profile>`); every other variant is a disjoint sibling
directory (`embed/<profile>.<variant-id>`). A variant has its runtime, encoding, WASM requirement,
package path, entry, manifest identity, transfer report, and stored and decoded file identities.

`channels/latest.json` is a discovery pointer. It is not a fixed dependency.

The loader uses these reason codes:

- `aborted`
- `bad_index`
- `bad_options`
- `excluded`
- `fallback_adapter`
- `fetch_failed`
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

## Future delivery

npm delivery is planned. No date is set.
