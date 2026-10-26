# Third-party notices

PI-Terminal itself is licensed under the **Apache License 2.0** (see `LICENSE`).

The plugin bundles its runtime dependencies into `main.js` at build time, so
their licenses travel with the built artifact. All of them are permissive and
compatible with Apache-2.0.

| Package | Version | License | Use |
|---|---|---|---|
| @xterm/xterm | 6.0.0 | MIT | terminal rendering (default DOM renderer) |
| @xterm/addon-fit | 0.11.x | MIT | cols/rows fitting |
| @xterm/addon-web-links | 0.12.x | MIT | clickable links |
| ssh2 | 1.17.0 | MIT | SSH client |
| ssh2-sftp-client | 12.1.x | Apache-2.0 | SFTP file/folder upload and download (put/fastPut/uploadDir/get/fastGet/downloadDir) |
| concat-stream | 2.0.x | MIT | ssh2-sftp-client dependency (buffers `get` without a destination) |
| asn1 | 0.2.x | MIT | ssh2 dependency |
| bcrypt-pbkdf | 1.0.x | BSD-3-Clause | ssh2 dependency |
| tweetnacl | 1.0.x | Unlicense | ssh2 dependency (via bcrypt-pbkdf) |
| safer-buffer | 2.1.x | MIT | asn1 dependency |
| font-list | 2.1.x | MIT | enumerating installed system fonts |
| @particle-academy/fancy-pty | 0.2.0 | MIT | pty helper executable (one binary per platform, shipped in `bin/`) |

## Deliberately not bundled

- **`cpu-features`** — ssh2's optional native accelerator for key derivation.
  It is roughly 16 MB of source plus per-platform object files, and ssh2 falls
  back to its pure-JS implementation when it is absent. Shipping it would trade
  a large part of the package size for one more way for a native module to fail
  to load.
- **`nan`** / **`buildcheck`** — build-time helpers for compiling the optional
  native addon above. Neither is required at runtime.
- **`tweetnacl` is bundled** even though nothing references it textually in
  ssh2's own source: it is a transitive dependency of `bcrypt-pbkdf`
  (`ssh2 → bcrypt-pbkdf → tweetnacl`), and removing it makes `require('ssh2')`
  throw `MODULE_NOT_FOUND`.

## Packaging note

PI-Desktop's installer skips any directory named `node_modules`, so the plugin
ships **no** `node_modules`: every runtime dependency is inlined into `main.js`
by esbuild, and the two things that genuinely need files on disk are published
outside that directory (`bin/<platform>/` for the pty helpers,
`vendor/font-list/` for font-list's platform assets).
