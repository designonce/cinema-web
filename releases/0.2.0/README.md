# Cinema web releases

This repository holds published Cinema web releases. The release index lists every build that
exists.

Cinema uses three levels:

- C uses WebGL2.
- B uses WebGPU.
- A is a higher WebGPU level.

Today, every release has only level C: `embed/web-basic-webgl2`. Level B or A exists only after
Cinema builds it and lists it in the index. Do not assume that an unlisted level exists.

## URLs

The browser host is `https://designonce.github.io/cinema-web/`. Use an exact release URL in an
embedding page:

```text
https://designonce.github.io/cinema-web/releases/<version>/loader/choose.mjs
```

The changing convenience pointer is `https://designonce.github.io/cinema-web/channels/latest.json`.
It points at the newest published version. Use an exact version when you need repeatable bytes.

Do not use raw GitHub as a module host. It does not provide the supported browser delivery for these
modules.

## Use in a browser

This example loads one build, defines the custom element, and reports every selection attempt. Put
the element in the page before this script.

```html
<cinema-viewer scene-mode="basic"></cinema-viewer>

<script type="module">
  import { loadViewer } from 'https://designonce.github.io/cinema-web/releases/<version>/loader/choose.mjs';

  const result = await loadViewer();
  console.table(result.attempts.map(({ level, backend, reason }) => ({ level, backend, reason })));

  if (!result.ok) {
    console.error('Cinema viewer did not load:', result.reason);
  }
</script>
```

`attempts` records each candidate and its reason. A failed result also has `reason`. Keep these
values in the page log or error report.

The loader selects a build before it imports that build. After an import starts, there is no
fallback. A failed import, startup, hash check, or custom-element registration does not cause
another profile to load. Reload the page with an explicit exclusion to try another build.

## Page requirements

The embedding page must meet these requirements:

- It runs in a secure context.
- Its `script-src` policy allows the host that serves the loader and modules.
- Its `connect-src` policy allows that host for manifests, JavaScript, and WASM bytes.
- The browser permits WASM compilation.
- The browser supports WebGL2.

A successful publication check proves that the release URLs and hashes match. It does not prove that
a browser, CSP, GPU, or webview can run the viewer.

## Use from an agent

### Web chat or hosted artifact

Do not use claude.ai artifacts for Cinema web releases. Their measured CSP blocks scripts and
fetches from GitHub hosts. This includes GitHub Pages and raw GitHub URLs.

### CLI agent

Download an exact release. First, download the index and the profile manifest with `curl`.

```sh
base=https://designonce.github.io/cinema-web/releases/<version>
curl -fsSLo index.json "$base/index.json"
curl -fsSLo manifest.json "$base/embed/web-basic-webgl2/manifest.json"
```

Make sure that the manifest byte count and SHA-256 match the `builds[].manifest` value in
`index.json`. Then download every path in `manifest.json` without changing its bytes. Make sure that
each downloaded file matches its `manifest.files[PATH].bytes` and `manifest.files[PATH].sha256`
values.

Keep the release layout when you copy the files. Serve that layout unchanged on localhost. For
example, serve the directory that contains `releases/`:

```sh
python3 -m http.server --directory /path/to/release-root 8000
```

Then import `http://localhost:8000/releases/<version>/loader/choose.mjs`. Localhost is a secure
context in supported browsers.

### Desktop app or webview

Bundle the selected profile directory and `loader/choose.mjs` on the same origin. Keep the profile
files unchanged. Then run the loader probe in that webview before you offer the viewer.

### Headless browser or CI

Use the index, manifest, and SHA-256 values for delivery checks. Run a browser probe only in the
target headless browser with WebGL2 available. A Node-only run cannot prove WebGL2, CSP, WASM
compilation, or viewer startup.

## Index and pointer formats

Each release has `releases/<version>/index.json`. It is canonical JSON with these top-level fields:

- `index_version`
- `artifact_version`
- `loader`
- `builds`

Each build states its product, profile, level, backend, input kinds, profile `path`, entry module,
requirements, manifest identity, catalog hash, protocol version, render-package version, and
transfer size. `path` is the package directory, such as `embed/web-basic-webgl2`, with no trailing
slash. `entry` is a path relative to that directory, such as `viewer.mjs`. Build order is loader
selection order.

`channels/latest.json` is a small pointer with `pointer_version: 1`, `artifact_version`, `index`
(the release-relative `releases/<version>/index.json` path), `source_sha` (the 40-hex Hotel commit),
and `tag` (`v<version>`). It is useful for discovery, not for a fixed dependency.

The loader uses these reason codes:

- `aborted`: the caller's abort signal stopped selection or a capability probe.
- `bad_index`: the fetched index is invalid or has an unsupported format.
- `bad_options`: selection options are invalid.
- `excluded`: the caller excluded this profile.
- `fetch_failed`: the index could not be fetched.
- `insecure_context`: the build requires a secure context.
- `insufficient_limit`: a required GPU limit or WebGL2 sample count is too low.
- `malformed_entry`: a build requirement is malformed.
- `missing_feature`: a required WebGPU feature is unavailable.
- `no_wasm`: WebAssembly compilation is unavailable.
- `timeout`: index fetch or decode, an adapter, or a WASM probe exceeded its timeout.
- `unavailable_adapter`: no usable WebGPU adapter is available.
- `unavailable_webgl2`: WebGL2 is unavailable.
- `unsupported`: no build remained after selection.
- `unsupported_input`: a build does not accept the requested input kind.
- `viewer_load_failed`: the selected viewer could not import or start.
- `wasm_compile_blocked`: policy or CSP blocked WASM compilation.

## Future delivery

npm delivery is planned. No date is set. A later npm design must split the current large WASM file
before it can use hosts with a 20 MB file limit.
