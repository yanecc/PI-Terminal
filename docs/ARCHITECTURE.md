# Architecture

## Layers, and why each boundary is where it is

```
src/protocol.ts          wire types + channel names (pure data)
src/host/index.ts        the three host hooks; wiring only
src/host/channels.ts     the single inbound entry (validation lives here)
src/host/sessions.ts     session registry: seq, buffers, limits, state machine
src/host/factory.ts      local vs ssh — the only place that knows the difference
src/host/transport/*     Transport interface + fancy-pty / ssh2 adapters
src/host/relay/*         loopback NDJSON stream (server + framing)
src/host/ssh/*           profiles, known_hosts, credential encryption, SFTP transfers
src/host/tools/*         agent tools (declarations + implementations)
src/view/*               the panel page (xterm, stream consumer, UI)
```

### Why the control plane is short-call only

PI-Desktop forwards custom panel channels with a 30 s timeout and provides no
host→plugin push channel. Anything that waits (terminal output, SSH handshakes)
therefore cannot live on that channel. The control plane carries only calls that
finish quickly; output has its own transport.

### Why a loopback HTTP stream

`fetch` + a readable stream needs no extra permission beyond `net.fetch` on
`127.0.0.1`, and reconnection is just "GET again with `?from=<seq>`". WebSockets
would add a second connection lifecycle and another permission for no benefit
here. The server binds `127.0.0.1:0`, requires a bearer token bound to one
session, rejects `Origin`-bearing requests and non-loopback `Host` headers.

Back-pressure is real: the view awaits `xterm.write(bytes, cb)` before reading
the next chunk, so a runaway command cannot grow the browser's memory.

### Why the ring buffer stores chunks, not bytes

Readers (view, model) address output by `seq`. Trimming must therefore drop whole
chunks — cutting a multi-byte character in half would render a broken glyph and
hand the model invalid UTF-8. `read()` reports `truncated` when the requested
start is already gone instead of pretending the output is complete.

### Why host-key verification is two-phase

ssh2's `hostVerifier` is synchronous, but asking the user is asynchronous. The
common bug is to `return true` and ask afterwards — by then the password or key
has been offered to the server. So:

1. **probe**: connect, `return false` in `hostVerifier`. That callback runs
   during key exchange, before authentication, so refusing it sends nothing.
2. **decide**: compare against `known_hosts`; unknown → ask; changed → refuse.
3. **connect**: same fingerprint must match exactly, or the handshake fails.

Jump hosts go through the same three steps; being a jump host is not a reason to
skip verification.

### Why credentials are encrypted by the plugin

The host does not expose its `secrets.*` API to plugins. The plugin therefore
encrypts at rest itself, using the OS keystore where available and falling back
to a 0600 AES-256-GCM key file, and it reports which backend is in use in
Settings so the user knows the real strength.

## Data flow

```
user keystroke → xterm.onData → term.input (invoke) → Registry.write → Transport
pty/ssh bytes  → Transport.onData → Registry.flush(8ms coalesce) → RingBuffer
                                   → RelayServer → NDJSON → view → xterm.write
                                   → term.read (model tools, redacted)
```

`seq` is assigned once, at flush time, and never reused. Both the view and the
model read from it, so a reconnect or a tool call resumes exactly where the other
stopped.

## Limits (and why)

| Limit | Value | Reason |
|---|---|---|
| live sessions | 8 (1–16) | one pty + one ssh connection each; keeps memory and process count predictable |
| per-session buffer | 2 MiB (256 KiB–8 MiB) | enough scrollback for a build log without holding a 1 GB `yes` |
| chunk | 512 KiB | keeps IPC and stream frames far below any frame cap |
| model read | 64 KiB / 2000 lines | a tool result must stay usable in a context window |
| inline upload | 32 MiB | base64 over a control channel; larger payloads belong in a file/folder transfer (SFTP) |
| inline download | 256 KiB (max 1 MiB) | a tool result must stay usable in a context window; bigger files are written with `localPath` |
