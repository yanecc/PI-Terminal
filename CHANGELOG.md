# Changelog

### 1.0.0 — the package no longer ships `node_modules`

- **`node_modules` is gone from the archive entirely (10.40 MiB → 5.84 MiB,
  582 → 50 entries).** It never worked: PI-Desktop's installer
  (`host-core/src/plugins/install.rs`, `copy_dir_filtered`) refuses to copy any
  directory named `node_modules` —
  `if name_str == ".git" || name_str == "node_modules" { continue; }` — so
  everything placed there was silently dropped on install. The plugin kept
  working only because `build.mjs` already inlines ssh2, ssh2-sftp-client and
  the rest into `main.js`; the shipped copy was dead weight that also made the
  package look like it depended on files the user would never receive.
  The two things that genuinely need to exist on disk now live outside that
  directory: `bin/<platform>/` for the pty helpers and `vendor/font-list/` for
  font-list's platform assets. `main.js` requires nothing at runtime except
  Node built-ins plus ssh2's optional `cpu-features` / `nan` (both degrade to
  pure JS when missing).
- **Guarded, not just removed.** `scripts/package.mjs` fails the build if
  `main.js` ever regains a runtime `require()` of a package that should be
  bundled; `scripts/package-check.mjs` fails if any `node_modules/` entry
  reappears in the archive; and `scripts/bundle-run-check.mjs` **deletes
  `.git` and `node_modules` after extracting** — reproducing the installer —
  before asserting the plugin still loads through the real host sidecar and
  still carries the ssh2/SFTP code.

### 1.0.0 — panel tab label, and a 33% smaller package

- **The work-panel tab said `PI-Terminal`; it now says `Terminal` / `终端`.**
  The tab is the line a user reads above the New-session buttons, and it should
  describe *what the panel is*, not *who provides it*. The plugin name is still
  the manifest name and the command prefix (that is where identity belongs).
  The view's `<title>` follows. `smoke.mjs` now asserts both the exact tab text
  and that it differs from the plugin name, so the two cannot drift together
  again.
- **The package dropped from 10.40 MiB to 6.93 MiB** (−33%, 582 → 153 entries),
  with no loss of function. Here is exactly where the 3.5 MiB went:

  | What | Before | After |
  |---|---|---|
  | `node_modules/@xterm/*` | 2.34 MiB | **0** — xterm is inlined into `views/assets/view.js` by esbuild; the host bundle never mentions it |
  | `@xterm/xterm/src` + typings, `.d.ts`, `.ts` | 1.44 MiB | 0 |
  | package docs (`README`, `.org`, `CHANGELOG`) | 0.36 MiB | 0 |
  | `ssh2` tests / examples / `.github` | 0.35 MiB | 0 |
  | `buildcheck`, `nan` (optional native build) | 0.50 MiB | 0 |

  Every removal was verified by actually extracting the `.piplug` and requiring
  the runtime deps **from that folder** (`scripts/bundle-run-check.mjs`), not by
  reading source and guessing. Two of my first guesses were wrong and would have
  shipped a package where SSH was completely dead: `safer-buffer` and
  `tweetnacl` are transitive deps (`ssh2 → asn1 → safer-buffer`,
  `ssh2 → bcrypt-pbkdf → tweetnacl`), so scanning `ssh2`'s own source says
  "unused" while deleting them makes `require('ssh2')` throw `MODULE_NOT_FOUND`.
  Every repo-local check still passed, because the checkout has a full
  `node_modules`. Both are back in the package.

  **Kept on purpose: the six pty helpers (4.17 MiB) — and they are now
  mandatory.** A `.piplug` is *one* cross-platform bundle: the same file
  installs on Windows, macOS and Linux, and each platform needs its own helper
  or its local terminal cannot start. `scripts/package.mjs` therefore **fails**
  when any of the six is missing instead of warning, and there is deliberately
  no "build for this platform only" switch — that would produce a package that
  works on the build machine and is broken everywhere else. `package-check.mjs`
  asserts all six entries are present *and* carry the execute bit, and
  `bundle-run-check.mjs` re-checks them after extraction.

### 1.0.0 — pre-release review fixes

Five defects found by review that no automated check covered. All five are
fixed and now covered by real tests.

- **First connection to an unknown host could never succeed.** The host key
  prompt never appeared: `state.pendingHostKey` was declared in the view and
  read by the dialog renderer, but **nothing ever assigned it**. Meanwhile the
  plugin was parked inside `onHostKey` waiting for a decision (20 s, then
  "refused"), and that pending `invoke` also blocked the view. The pending
  request is now published on the session summary (`hostKeyPending`), and the
  view's one-second sync picks it up and opens the dialog; the decision wakes
  the waiting connection and the summary clears. Sessions waiting for a
  confirmation are deliberately **not** filtered out of `list()` as
  "not-yet-started" — otherwise the dialog could never see them.
  New `scripts/hostkey-confirm-check.mjs`: real ssh2 server, real
  registry + factory + transport.
- **Keychain / libsecret stored every profile under one name.** The macOS
  service name was empty and libsecret's account was the constant `default`, so
  saving a second host's password overwrote the first; the macOS lookup also
  used mismatched `-s`/`-a` arguments and could never read back what it wrote.
  Both backends now key on `<profileId>.<kind>` with symmetric query
  parameters, and the account is recorded in the sidecar so old entries stay
  readable.
- **Jump hosts were unusable.** The target was probed from *this* machine
  (fails for anything only reachable through the jump host), the tunnel was
  forwarded to `hop.host:hop.port` — the jump host itself — and the target's
  fingerprint was never verified inside the tunnel. It is now "connect, then
  probe further": each hop is probed and connected over the previous hop's
  tunnel, the target is probed over the last hop's tunnel, and the probe uses a
  dedicated tunnel so the real handshake gets a fresh one. Also fixed:
  `probeHostKey` no longer calls `client.end()` when probing over a borrowed
  tunnel (that destroyed the channel the real connection needed).
  New `scripts/jump-check.cjs`, driven by a real two-hop chain.
- **SSH sessions never reported a working directory.** `probeCwd()` returned a
  field nothing ever set (`setCwd()` had no callers), so every SSH tab said
  "unknown cwd". The factory now runs `pwd` once on the authenticated
  connection (with a timeout, empty on failure) and stores it.
- **`known_hosts` did not compare key types.** Only entries of the *same*
  algorithm now count as a changed fingerprint; a first sighting of a different
  algorithm (recorded ed25519, negotiated rsa) is "unknown" instead of a
  refusal. `guessKeyType` no longer defaults to `ssh-rsa` — when it cannot tell,
  the comparison conservatively falls back to every entry. Unit-tested.
- **"Clear credential" left the secret in the OS keystore.** `remove()` only
  unlinked the local placeholder, but on macOS/Linux the ciphertext lives in
  Keychain / libsecret — anyone could still read it back with
  `security find-generic-password` / `secret-tool lookup`. It now issues
  `security delete-generic-password` / `secret-tool clear` first, using the
  account recorded in the sidecar (falling back to a computed one, so entries
  written by older builds still get removed). New
  `scripts/secrets-remove-check.cjs` asserts the argv of both backends.
- **One confirmation could only release one of several concurrent connections.**
  Pending host-key requests were kept as `Map<key, callback>`, so a second
  connection to the same unknown host overwrote the first, and the user saw
  "I clicked Trust and it still failed" for all but one tab. The map now holds
  a `Set` of waiters: a single decision wakes every connection waiting on that
  fingerprint, a timeout only removes itself, and the entry is dropped once
  empty. New `scripts/hostkey-concurrent-check.mjs` drives two real
  simultaneous connections.
- **Concurrent `known_hosts` writes corrupted each other.** The temp file was
  named `<path>.<pid>.tmp` — unique per *process*, not per *write* — so two
  connections released by the same confirmation raced on it: whichever renamed
  first, the other got `ENOENT` (and could drop the winner's entry by writing
  stale text over it). Writes now carry a random suffix and go through a
  serialised `commit()`, so the whole read-modify-write happens on one chain.
- **A failed keystore delete was reported as success, and blocked every
  retry.** `remove()` wrapped `security delete-generic-password` /
  `secret-tool clear` in `.catch(() => undefined)` and then unlinked the
  placeholder *and* its `.meta` sidecar. So when the keystore was locked or
  refused the delete, the credential stayed in Keychain while
  `ProfileStore.clearPassword` looked like it had worked — and because `.meta`
  (the only record of which keystore account this credential lives under) was
  gone, a retry could only guess the account name. Failures now propagate, and
  the local side is only touched *after* the keystore confirms. `exit 44`
  ("item not found") still counts as success, otherwise a stale entry would
  fail on every retry. `ProfileStore.remove()` likewise deletes the credential
  before touching the profile table, so a refused delete keeps the profile
  around instead of orphaning the keystore entry.
- **A local unlink failure was also reported as success.** The two `unlink`
  calls on the credential file and its `.meta` were wrapped in
  `.catch(() => undefined)`, so a file that could not be removed (permission
  denied, held open on Windows) still looked deleted. On the dpapi and
  passphrase-file backends the ciphertext *is* that file, so the credential
  really did survive while the UI said "cleared". Only `ENOENT` is ignored now
  ("already gone" is the requested end state); anything else propagates.
  `remove()` runs keystore → local file → `.meta`, so the keystore is always
  cleaned first, and `.meta` survives any failure — a retry then hits `exit 44`
  on the now-empty keystore (treated as success) and finishes by deleting the
  file. `scripts/secrets-remove-check.cjs` grew from 10 to 26 assertions
  covering the failure, retry, and already-absent paths.
- **`known_hosts` writes could still fail on Windows.** Replacing the file is
  a `rename` onto an existing target; if anything held a handle on it for a
  few milliseconds (indexer, AV scanner, a concurrent read) it returned
  `EPERM`. The rename now retries with backoff on `EPERM`/`EBUSY`/`EACCES`/
  `EEXIST`.
- **The plugin is called `PI-Terminal` everywhere.** The manifest `name`, both
  `i18n` entries (zh-CN included — the Latin spelling stays recognisable in a
  one-line tab strip), the view's `<title>`, the command titles and the command
  *category* all read `PI-Terminal`, and the command ids use the plugin's own
  prefix: `pi-terminal.closeAll` / `pi-terminal.resetSettings` (were
  `terminal.*`, the same word the host already puts in front of every tool).
  Any keybinding that mentioned the old ids needs updating.
- **Author is `Sunrise`** (was the generic "PI-Desktop plugin"), in the manifest
  and in `package.json`.

### 1.0.0 (follow-up) — two commands, session-limit-safe connection test

- **The command palette is down to two entries**: `Terminal: Close All Sessions`
  and the new `Terminal: Reset All Settings`. `Terminal: Open`,
  `Terminal: New Local Session` and `Terminal: New SSH Session` are gone — the
  panel already has those buttons, and a session started from a command had to
  guess its size (100×30) instead of using the panel's. The reset command writes
  through the same `applySettings` path as the panel, so an open panel picks the
  defaults up immediately.
- **Fixed: testing a saved host failed with "at most 8 live sessions" once the
  tabs were full.** The connection test used to open a throwaway *session* (and
  close it in `finally`), so it competed for the live-session limit — the user
  saw a limit error that has nothing to do with SSH and reasonably concluded the
  host was unreachable. A test is a one-off probe, not a terminal: it now goes
  through `probeSshProfile`, which walks the same fingerprint → `known_hosts` →
  auth → shell sequence on its own connection and never touches
  `SessionRegistry`. The agent's `profile action="test"` was rewritten the same
  way. Regression covered in two places: `npm test` (a full registry rejects a
  second session while a probe still succeeds) and `scripts/smoke.mjs` (fill all
  eight slots, run a test through the real panel channel, and assert the reply is
  `NOT_FOUND` for an unknown host — never `LIMIT` — and that the session list is
  unchanged).

## 1.0.0 — SFTP transfers, short tool names, new plugin id

- **Tool names lost the `terminal_` prefix.** The host already registers every
  plugin tool as `plugin_local_pi_terminal_<name>`, so `terminal_read` was
  showing up as `…_terminal_terminal_read`. The surface is now
  `read` / `send` / `wait` / `upload` / `download` / `session` / `profile` /
  `setting` (eight tools; the last three keep their `action` parameter).
  **Breaking change** for anything that called the old names.
- **All SFTP work goes through `ssh2-sftp-client`.** The previous code built
  `SFTPStream` primitives by hand (one `writeFile` for text, a temp file plus
  `fastPut` for binaries), which could not express folders at all. File
  semantics now belong to the library: `put`, `fastPut`, `uploadDir`, `get`,
  `fastGet`, `downloadDir`. Transfers reuse the session's **already
  authenticated** `ssh2.Client`: the client is handed to a fresh `SftpClient`
  and only the SFTP subsystem channel is opened, so there is no second
  handshake, no second host-key prompt and no second use of the credentials.
  `SftpClient.end()` is never called — it would end the client that carries the
  user's shell — only the subsystem handle is closed.
- **New `download` tool.** A file with `localPath` is saved there (parent
  folders are created); without `localPath` a file that fits the inline limit
  (256 KiB default, 1 MiB max) is returned as content, decoded as UTF-8 or, when
  the bytes are not valid UTF-8, as base64 with a note. A folder always needs
  `localPath` and is copied recursively into it.
- **`upload` grew two shapes.** Besides inline text/base64 it now takes
  `localPath`: a file is uploaded to `remotePath`, a directory has **its
  contents** copied into `remotePath` (created if missing). Passing both
  `content` and `localPath` is refused instead of guessing.
- **`stream` on both transfer tools** follows one rule: `false` (default) moves
  data in parallel chunks — `fastPut`/`fastGet`, and `uploadDir`/`downloadDir`
  with `useFastput:true` / `useFastget:true`; `true` uses a single stream —
  `put(readable, remotePath)` / `get(remotePath, writable)`, and the folder
  variants with the fast paths disabled — for servers that do not support the
  extended requests. Every reply names the call that was actually used
  (`transport`), so an unexpected fallback is visible.
- **The plugin id is `cc.fee.pi-terminal`** (was `local.pi-terminal`). The
  install directory, the data directory and the id the host shows all change;
  an existing install is not migrated, so install the new `.piplug` and remove
  the old one.
- **New `scripts/sftp-check.mjs`** replaces `upload-check.mjs`: a real ssh2
  server with a minimal SFTP subsystem drives every path above (inline text,
  file via `fastPut`, file via `put(readable)`, folder upload in both modes,
  inline download, `fastGet`, `get(remotePath, writable)`, folder download in
  both modes, the inline limit, and a transfer after the connection closed).
  It found a real bug in its own first draft: `OPEN` flags arrive as a numeric
  bitmask, and treating every `OPEN` as a write truncated the source before
  reading it.
- `scripts/install-check.mjs` treats "not installed yet" as a warning now
  (the new id has no directory until someone installs it) and only fails when
  an explicitly given directory is missing; `host-load-check.mjs` falls back to
  the repository root for the same reason, so it still proves the host sidecar
  can load the plugin.

## 0.1.5 — consolidated agent tools

- **Seven agent tools instead of fourteen.** Session, connection-profile and
  settings actions used to be flat (`terminal_list_sessions`,
  `terminal_new_session`, `terminal_get_settings`, …). They are now one tool per
  object with an `action` parameter — `terminal_session` (list/create/close),
  `terminal_profile` (list/create/update/delete/test) and `terminal_setting`
  (list/get/update/reset) — while `terminal_read`, `terminal_send`,
  `terminal_wait` and `terminal_upload` keep one tool per verb. The host grants
  approval per tool, so each grouped tool carries its worst action:
  `terminal_profile` is `high` (delete takes the stored credentials with it),
  `terminal_session` and `terminal_setting` are `medium`. **Breaking change** for
  anything that called the old names.
- **An omitted index parameter never means "all".** `terminal_setting`
  `action="reset"` without `key` is refused and tells the caller to pass
  `key: "*"` for a full reset; the same rule covers `sessionId` and `profileId` on
  close / update / delete / test. A call missing an id can no longer turn into a
  bulk modification or a bulk close.
- **`terminal_upload` handles binary files.** With `encoding: "base64"` the
  content is decoded and pushed with `sftp.fastPut` (temp file, chunked parallel
  upload, mode applied via fchmod); plain text keeps the single `writeFile` path,
  which is cheaper for small files. Upload failures are returned as data now
  (`AUTH` for permission problems, `INVALID` for a missing path) instead of
  escaping as exceptions, and the reply names the transport that was used.
- **`cwd` in `terminal_session action="create"` actually works.** It was declared
  but dropped before it reached the pty; the session registry and the factory now
  carry it through, and a non-absolute or missing directory is reported before a
  shell is spawned.
- **`terminal_send` with `enter: true` now really runs the command.** It appended a
  bare `\n`, which Windows' ConPTY/PSReadLine treats as an ordinary character: the
  text appeared, the caret sat at the end of the line and nothing executed. The
  tool now sends `\r` — what a real Enter key produces, and what POSIX termios
  maps via ICRNL — and normalises every line break inside `text` to `\r`, so one
  line break equals one Enter. Verified against a real local pty: `echo …` comes
  back with its output followed by the next prompt.
- **The agent can tell which tab the user is looking at.**
  `terminal_session action="list"` marks exactly one session with `active: true`.
  The panel reports its active tab over `term.session.activate` on every switch
  (and reports "none" when the last tab closes), so the flag means *on screen
  right now* — not "most recently created" or "most recently written to". Closing
  the active session clears it on the host side as well.
- **`terminal_session action="close"` accepts `sessionId: "*"`.** Closing one
  session still needs a concrete id (an omitted id stays refused), but the
  explicit wildcard closes all of them — including the ones still starting, which
  `list` deliberately hides — and returns how many were closed.
- **`terminal_session action="create"` can choose the shell.** `shell` takes a
  command name resolved on PATH (`nu`, `bash`) or an absolute path
  (`C:\Program Files\PowerShell\7\pwsh.exe`) and goes through the same resolution
  as the settings default: PATH lookup to an absolute path, existence check for
  absolute paths, `-NoLogo` for the PowerShell family. Arguments are rejected
  (`"cmd /c x"` is not a shell), and an unknown binary comes back as `INVALID`
  with "not found on PATH" instead of a spawn failure. Combined with `cwd` you can
  now open, say, a `cmd` session in a specific directory without touching the
  global settings.
- **Right-click a tab for Copy session id / Rename.** The tab strip had no mouse
  affordance beyond double-click-to-rename, and that path went through
  `window.prompt` — which Electron webviews block, so it silently did nothing.
  Renaming is **inline** now: the tab title becomes an input, Enter or blur
  commits, Escape or an empty value cancels. The menu also copies the session id,
  which is exactly what you need to feed `terminal_read` / `terminal_send` from
  another session.
- **`terminal_session action="create"` honours `title`.** It was declared but the
  factory overwrote it with the directory name (or `user@host` over SSH), so a
  named session still showed up as `pi-terminal`. An explicit title now wins and
  the directory/host name is only the fallback.
- **Saving a profile retries a transient Windows lock.** `rename` over an existing
  `profiles.json` occasionally fails with EPERM/EBUSY while the antivirus or the
  search indexer has the file open; that surfaced as a random "could not save the
  host". The write now retries with a short backoff before giving up.
- **Settings changed outside the panel now take effect immediately.** The panel
  applied font/size/cursor changes locally, but a change coming from the agent
  (`terminal_setting update`) only reached the plugin process: the open view kept
  its old snapshot, so an already-created terminal kept the old font until
  PI-Desktop was restarted. The host now pushes the new settings over the existing
  loopback stream (`{ t: "settings" }`, broadcast to every connected panel) and the
  view re-applies them to live terminals; when the relay is switched off, a
  five-second poll covers the same case. Verified in a real browser: a host-side
  `term.settings.set` turns an open terminal from 13px to 18px without touching the
  panel, a new tab inherits 18px, and with the relay off the poll still applies
  21px. The settings pane is never re-rendered while a control has focus, so a
  background change cannot wipe what you are typing.
- **Two settings that never worked now do.** `relayEnabled` was only consulted in
  `onLoad`, so toggling it needed a restart — it now starts/stops the loopback
  server on change. `sshKeepaliveSeconds` was read by nothing (the SSH transport
  only looked at the per-host value): it is now the default for connections whose
  profile does not set one.
- New `scripts/upload-check.mjs`: a real ssh2 server with a minimal SFTP
  subsystem, proving both upload paths move bytes — and the file mode — across the
  wire. It runs as part of `npm run verify`.
## 0.1.4 — a new local terminal no longer turns into a dead tab

- **The 7th (and later) terminal tab is no longer blank.** Every session used to
  open its own long-lived `fetch` to the loopback relay, and browsers cap
  concurrent connections per host:port at **6** — so from the 7th session the
  request was never even sent: the tab showed `connecting`, `seq 0`, and stayed
  empty. The relay now keeps **one** NDJSON connection for the whole view
  (`?sessions=<id>:<from>,…`, events carry a `session` field) and the view demultiplexes
  it. Reconnects after membership changes re-send each session's `from` seq, so
  nothing is drawn twice. Verified with 8 and 12 "new local" clicks: every tab
  renders its prompt and the status line says `live`.
- **Default font size is 13**, and it now comes from one place
  (`DEFAULT_SETTINGS.fontSize`): the view no longer hard-codes 12 in three
  different fallbacks while the host defaulted to 14. The settings field, its
  placeholder and the initial xterm font size all read that value.
- **The font drop-down is the same width as the other settings.** It used to be
  allowed to stretch to the whole row because font family names are long; it is
  now capped like every other control (long names are ellipsised by the select
  itself).
- **Six more agent tools: settings and saved hosts.** The model can read the
  plugin's settings together with their defaults (`terminal_get_settings`), change
  them (`terminal_update_settings` — unknown keys and wrong types come back as
  `problems` instead of being silently ignored, out-of-range numbers are clamped)
  and reset one or all of them (`terminal_reset_settings`). It can also create or
  update a saved SSH connection (`terminal_save_profile`), delete one
  (`terminal_delete_profile`, `high` risk because it takes the stored credentials
  with it) and connection-test one (`terminal_test_profile`: a short-lived session
  that is closed again immediately). Passwords and key passphrases are refused by
  design — they are entered in the panel, so they never become part of a model
  transcript. The panel and the tools share one input normaliser
  (`normalizeProfileInput`) and one settings writer, so the two cannot drift.- **Every settings row is the same row.** One grid for all of them: title on the
  left, control in the middle, a "reset to default" button on the right. The
  three check-box rows used to be a single `<label>`, which pushed their titles to
  the right of the box and out of the column; the box now sits in the control
  column like every other input. Each row can be reset on its own: the button is
  disabled while the value already equals its default and re-enables the moment
  you change it. The defaults come from the host (`term.settings.get` now returns
  `defaults` next to `settings`), so there is still one source of truth for them.
- **Less filler text in the settings pane.** "Default shell (empty = auto)" lost
  the parenthetical and its field now says what to type instead
  ("command name or absolute path"); the hint lines under the shell and font
  fields are gone entirely.
- **The system font list comes from `font-list` now.** The plugin no longer shells
  out to the registry / `fc-list` / `system_profiler` on its own: `getFonts2()`
  returns `{ familyName, monospace }` on every platform and the drop-down filters
  on `monospace: true`. It ships in `vendor/font-list/` instead of being bundled
  into `main.js`, because it looks for its own platform assets next to itself
  (`libs/win32/fonts.vbs`, the native `libs/darwin/fontlist`) and a bundler breaks
  that — and `node_modules` is deleted by the host installer, so `vendor/` is the
  only place it can actually live. Verified by extracting the real `.piplug`,
  deleting `node_modules` (exactly what the installer does) and starting the
  plugin from there: all 262 families still come back.
- **The `monospace` flag has a measurement fallback.** On this Windows build
  font-list reports `monospace: false` for all 262 fonts, because its check runs
  inside a one-shot `-command` whose errors are swallowed. A drop-down trusting
  only that flag would have offered nothing but "default", so the host returns the
  flag *and* the full family list, and the view falls back to a canvas
  measurement when the flagged set is empty (28 usable families on the test
  machine, none of them uninstalled).
- **Settings tab polished.** Grouped into Startup / Appearance / Sessions /
  Interaction / Network, controls aligned in one column at a consistent width, the
  output buffer edited in MiB instead of raw bytes, and every text and number
  field carries a placeholder that shows its default or an example instead of
  sitting empty.
- **The eye button is a closed eye now, not a struck-through one.** The hidden
  state used to be the open-eye outline plus a diagonal slash; at 16px the two
  strokes collided into a smudge. The states are separate drawings now — a
  closed lid with lashes while the password is hidden, an open eye with a pupil
  once it is shown — with matching stroke weight and the **same colour**;
  only the drawing says which state you are in.
- **Settings are back in the panel, as a fourth fixed entry.** The host's
  plugin-settings sheet can only render the options declared in the manifest at
  install time, so it can never list *the monospace fonts this machine actually
  has*. A `Settings` pane (same layer as `Hosts`, same button-to-return
  behaviour) is now the single entry for the plugin's settings, and
  `contributes.settings` is gone from the manifest. The values are still stored
  in the host's `settings.json`; `DEFAULT_SETTINGS` is the only source of keys
  and defaults, and every write is flattened (no nested `settings` key).
- **The terminal font is a drop-down of the system's real monospace fonts.** The
  plugin enumerates installed families (registry on Windows, `fc-list` /
  `system_profiler` elsewhere) and the view keeps only those that pass a canvas
  measurement: `i` and `M` must render equally wide, and the family must not
  measure the same as a deliberately missing name — which is exactly how an
  uninstalled font is detected, since the browser silently substitutes one.
  21 families were found on the machine used to test this. A stored family that
  no longer passes is still listed, so a setting never silently reverts.
- **Font changes apply to live terminals.** Font size, family and cursor blink go
  through a new `applyOptions()` on the xterm handle: the options are mutable, so
  nothing is rebuilt, no scrollback is lost and the running program is untouched;
  the grid is re-measured and the pty resized instead.
- **Fixed: the tab you just left stayed highlighted.** `data-active` is written
  only by `renderTabs()`, and switching sessions went through `activate()`
  without redrawing the tab strip — so the highlight was only right in the
  instant a tab was created, and every later switch left the old tab looking
  active while the new one looked idle. `activate()` now redraws the tabs as
  soon as `activeId` changes (verified in a real browser: exactly one tab
  carries `data-active="true"`, and it is the one you clicked).
- **Fixed: settings changed in the host's plugin-settings page did nothing.**
  The host writes those values straight into `<plugin data>/settings.json` and
  only posts a `plugin:settingsChanged` event, which the Node-side `pi` global
  offers no way to subscribe to; the plugin read the settings once in `onLoad`
  and kept that snapshot for its whole lifetime. Setting the default shell to
  `nu` therefore still started PowerShell: the session factory kept resolving
  the stale empty `defaultShell` and fell back to auto-detection. Settings are
  now read from the host at the moment they are used (opening a session from the
  view, a command or an agent tool; answering `term.settings.get`), with the
  cached value used only if the read fails, and the live-session limit and
  buffer size follow the fresh values. `setSettings` writes a flat object again
  instead of nesting everything under a `settings` key in the host's file.
- A configured shell given as an absolute path may now contain spaces
  (`C:\Program Files\PowerShell\7\pwsh.exe`); any space used to be rejected as
  if it were trailing arguments.

- **Fixed: opening a second terminal left the first tab blank.** `activate()` used
  `stage.innerHTML = ""` when a session got its terminal surface for the first
  time. That detaches **every** existing surface from the document, while the
  other sessions keep pointing at their now-orphaned elements — so switching back
  to an older tab showed an empty panel with a perfectly healthy terminal behind
  it. The view now removes only the non-session panels (empty state, hosts panel)
  and leaves session surfaces in place.
- **The work panel keeps exactly three fixed entries.** `New local`, `New SSH`
  and `Hosts`; the in-panel Settings button is gone (settings live in the host's
  own "plugin → settings" page, which is the single entry point). Clicking
  `Hosts` again returns to the terminal.
- **Hosts is a panel, not a dialog.** The saved-host list is rendered inside the
  stage (same layer as a terminal surface) with a toolbar pinned above it — an
  "Add host" button that never scrolls away. Add and edit open the overlay form
  (name, host, port, user, group, auth, credentials), so the list itself stays
  read-only and never jumps while you type.

- **Fixed: clicking "New local" did nothing at all.** Every failure path in the
  view used to end in a place the user could not see, so a broken open looked
  like a dead button. Four separate holes are closed:
  - **No feedback while the pty starts.** `openSession` really spawns a shell,
    which takes a moment; the button gave no sign of progress and repeated
    clicks each opened another session. The click now shows "Starting a local
    terminal…", is guarded against re-entry, and the guard is released in a
    `finally` so a failure cannot wedge the button forever.
  - **A failed open left the view inconsistent.** `addSession` ran before
    `activate`, so when activating failed the tab stayed with no terminal behind
    it — and the next click merely un-hid that empty element, which is exactly
    "clicking does nothing". `rollbackFailedSession` now drops any session that
    has neither a terminal nor a stream, redraws the tabs, and returns to the
    empty state or the last usable session.
  - **`createTerminal` threw into a silent catch.** Building the xterm instance
    is the one step where an exception left the tab drawn and the panel blank.
    It is now caught locally: the error goes to the status bar, the tab is marked
    failed, and the reason is logged.
  - **`window.alert` for the session limit.** Host webviews block synchronous
    dialogs, so hitting the limit produced no visible response at all. The limit
    now reports through the status bar like every other error.

  Verified in the browser against the real plugin process: repeated clicks open
  exactly one session, a forced failure shows an actionable error and leaves no
  stale tab, and clicking again succeeds.

- **Fixed: "New local terminal" produced a struck-through tab reading
  `local`, an `unknown cwd` tooltip, and an empty panel.** Three defects stacked
  into the same symptom, and only the first one was visible to the user:
  1. **The install directory had no `node_modules`.** The pty helper lives at
     `node_modules/@particle-academy/fancy-pty/bin/<platform>/fancy-pty-helper[.exe]`,
     so `openLocal` threw before it could report a title or a cwd. SSH kept
     working because ssh2 runs in-process and needs no helper — which is exactly
     why the failure looked terminal-specific. `scripts/install-check.mjs` now
     verifies the *installed tree* (not just the archive) and is part of
     `npm run verify`.
  2. **A failed `SessionRegistry.open` left a ghost session behind.** The entry
     was marked `failed` but kept in the list, so the view's one-second poll drew
     a tab for a session that never existed: no cwd, no transport, no output —
     i.e. struck through, `unknown cwd`, blank. Failure is now atomic: dispose,
     delete, emit `failed`, rethrow.
  3. **The view treated `starting` as "already over".** `startStream` bailed out
     unless the snapshot said `running`, and `renderTabs` painted the snapshot's
     `status` instead of the live stream state. A session that was still coming
     up therefore rendered as closed. The stream now connects for every
     non-terminal status, and tabs derive their lifecycle from the live state
     (`lifecycleOf`), consulting the snapshot only for explicit terminal states.
- **The missing-helper error is now actionable.** It names the expected path and
  says the usual cause is an install without `node_modules`, instead of pointing
  at a source checkout the user may not have.
- **`scripts/e2e-view.mjs` serves `/invoke` again.** Two request handlers raced:
  the static one answered every `POST /invoke` with 404, so the page only ever
  saw "Failed to fetch". Static and API handling now live in one router.

## 0.1.3 — reload loop, PowerShell environment, packaging

- **Fixed: the terminal occasionally showed "Reloaded …" and went blank.**
  `onLoad` fell back to `process.cwd()` when `getDataPath()` failed — i.e. the
  plugin wrote its audit log into its own install directory. PI-Desktop watches
  development plugin folders recursively and reloads on any change (only
  `node_modules/.git/dist/target` are exempt), so every audit write counted as a
  source edit: toast, view teardown, empty terminal. The data directory now never
  falls back to the install path (system temp is used instead), and stray runtime
  files were removed from the watched tree.
- **Fixed: only `cmd` saw environment variables on Windows 11.** The cause was
  not `PATH` — it was `PSModulePath`. A host started from Explorer gets the
  environment snapshot from login time, which in practice carried only the
  user-level module roots; the two system roots
  (`%ProgramFiles%\WindowsPowerShell\Modules`,
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules`) were missing. PowerShell
  loads its own module system from that variable, so its profile failed and
  `$env:` looked broken, while `cmd` (no module system) was fine. `PSModulePath`
  is now merged from Machine + User like `PATH`, with the same de-duplication.
- **Packaging is one code path on every platform, via `node:zlib`.** The old
  implementation branched per OS (Windows: `tar.exe --format zip`; elsewhere:
  `zip -0`). Two tools meant two behaviours for entry names, directory entries
  and permission bits, and the product depended on which archiver a machine
  happened to have (Git Bash's GNU `tar` rejects `--format zip` outright). The
  packer now builds `ZipEntry` objects itself and streams them through
  `createZipArchive`, so entry order, directory entries and modes are decided in
  one place.
- **The archive is byte-for-byte reproducible.** Entry timestamps are a fixed
  constant instead of each file's `mtime`: staging with `cp` refreshes `mtime`,
  which used to make two builds of identical sources produce different
  `sha256`s, so a checksum could never be used to prove "the payload didn't
  change". Three consecutive packages now yield the same digest.
- **Fixed: the six pty helpers were stored without the executable bit.** On
  Windows a file's `stat` mode has no `+x` (`666`), and copying that verbatim
  produced a package whose Linux/macOS helpers could not be spawned (`EACCES`) —
  a defect invisible when testing on Windows. Helper entries are now written
  `0755` explicitly; directories too.
- **Fixed: the previous archive was missing most of its payload.** It was
  3.4 MiB while the six helpers alone are 4.2 MiB, so dependencies had been
  dropped. The package is now 9.8 MiB and contains all 543 entries, verified by
  extracting it and running the plugin from the extracted copy (ping + a real
  pty echo).
- Default authentication for a new SSH profile is **password**.


## 0.1.2 — language, PATH and host management

- **Follows the PI-Desktop language.** The view carries an English and a
  Simplified Chinese message table and picks one from the host's
  `app.getAppearance()` / `appearance:changed` payload (which includes `locale`,
  the same path the host's own panel template uses), falling back to
  `app.getLocale`, then the browser language. `zh-TW` / `zh-Hant` resolve to the
  Simplified table rather than showing half-English text. A locale change
  re-renders the chrome without touching terminal output.
- **Local terminals inherit the full system PATH.** A packaged Electron app
  started from Explorer gets the environment snapshot from login time, so tools
  installed or PATH entries added afterwards are missing — the classic "command
  not found in the terminal but fine in a normal shell". The plugin now merges
  the registry's Machine + User PATH into the pty environment, process entries
  first, deduplicated by Windows rules (case and trailing separator insensitive).
  Verified by actually starting a pty with a crippled PATH and resolving a
  System32-only tool.
- **Hosts is now a manager, `+ SSH` is a picker.** In 0.1.1 both entries opened
  the same panel, so connecting meant hunting a Connect button among Edit/Test/
  Delete. `+ SSH` now lists hosts only (one click connects); Hosts manages them.
- **Hosts can be grouped.** Each profile has an optional free-text `group`;
  empty means "Ungrouped", which always sorts last. Groups collapse individually
  and remember their state for the session. Typing a group offers the existing
  ones as suggestions so near-duplicates are less likely.
- **The eye button moved inside the password fields**, flush right, in both the
  create and edit forms. It renders an inline SVG (no emoji font dependency),
  is `type="button"` so Enter cannot submit the form, and only fetches the saved
  plaintext when the field is empty (revealing it writes an audit line); a value
  you are typing is never replaced.
- The authentication selector keeps driving which fields exist: `ssh-agent`
  shows none, `private key` shows the path and passphrase, `password` shows the
  password. Switching away clears the now-irrelevant inputs as well as their
  stored values.

## 0.1.1 — usability fixes

- **The panel now follows the host's light/dark appearance.** The stylesheet
  previously used `var(--bg, #181818)`, but the host does not inject its CSS
  variables into a plugin view, so the fallback always won and the terminal
  stayed dark in a light app. Both palettes are now defined explicitly and
  switched by `<html data-base>`, which `app.getAppearance()` and
  `appearance:changed` drive.
- **Right-click pastes.** The context menu is gone: a right click is a paste,
  matching terminal habit. Copy is `Ctrl+C` with a selection, which also removes
  the old "which one did they mean" ambiguity.
- **`Ctrl+C` copies a selection without leaking `^C`.** The previous listener
  ran after xterm had already turned the key into ``; the filter is now
  installed through xterm's own `attachCustomKeyEventHandler`, so a selection is
  copied and only an empty selection reaches the shell as an interrupt.
- **SSH hosts can be edited.** Editing keeps the profile id (updates instead of
  creating a duplicate), pre-fills the non-secret fields, never echoes a saved
  secret back, and offers an explicit "forget the saved password/passphrase".
- **The form follows the authentication choice**: `ssh-agent` shows no
  credential fields, `private key` shows the path plus passphrase, `password`
  shows only the password field.
- Fixed: switching away from private-key auth left the old key path stored
  (invisible in the UI but active again if you switched back). An explicitly
  submitted empty value now clears it.
- Clipboard reads fall back to the host's `clipboard.read` capability when the
  sandboxed page is not allowed to use `navigator.clipboard`.

## 0.1.0 — first release

A terminal in PI-Desktop's work panel, built on xterm.js 6 (default DOM
renderer), ssh2 and `@particle-academy/fancy-pty`.

**Local terminals**
- Real pty per session, so interactive programs behave normally.
- Shell detection: `pwsh` → `powershell` → `cmd` on Windows; `$SHELL` → `zsh` →
  `bash` → `sh` elsewhere; overridable in Settings.
- Tabs with rename, live status dot, `Ctrl+Shift+T` / `Ctrl+Shift+W`.
- Copy on right-click, multi-line paste confirmation.

**SSH**
- Key, ssh-agent and password authentication; jump hosts (up to 4 hops).
- Host keys verified in two phases: the probe never sends credentials, and a
  changed fingerprint always refuses the connection.
- `known_hosts` in OpenSSH format, merged with `~/.ssh/known_hosts`.
- Keepalive, resize via window-change, SFTP upload for the agent tool.

**Sessions**
- Output ring buffer per session (2 MiB default), addressed by a monotonic `seq`
  so the view and the agent can both resume where they stopped.
- Live-session limit (8 by default), clear `LIMIT` error instead of a silent
  failure.
- Loopback NDJSON stream with back-pressure; automatic fallback to polling when
  the port is unavailable, with the fallback visible in the status line.

**Agent tools**
- `terminal_list_sessions`, `terminal_read`, `terminal_send`, `terminal_wait`,
  `terminal_new_session`, `terminal_close_session`, `terminal_list_profiles`,
  `terminal_upload`.
- Reads are redacted; anything that writes to a shell is `risk: high`.

**Security**
- Saved passwords encrypted with DPAPI / Keychain / libsecret (with an explicit,
  visible fallback to a 0600 AES-256-GCM key file).
- Reveal-on-demand is audited; audit never contains content or credentials.

**Known limits**
- Falls in the right work panel, not the left sidebar: PI-Desktop 0.20.x has no
  sidebar slot for plugin views.
- Two install warnings are expected: `net.local-domain` and `permission.high-risk`.
