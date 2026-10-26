<!-- Copyright (C) 2026 Admix Pty. Ltd.
SPDX-License-Identifier: MIT OR Apache-2.0 -->

# @designonce/cinema-web

WebGL2 cinema viewer custom element. Serve this package folder unchanged: `viewer.mjs` fetches
`manifest.json` and the WASM relative to itself and checks their SHA-256. If you use a bundler, copy
the entire package folder as static files instead of bundling its modules individually.

```html
<cinema-viewer scene-mode="basic"></cinema-viewer>
<script type="module">
  import { defineCinemaViewer } from '/cinema-web/viewer.mjs';
  defineCinemaViewer();
</script>
```
