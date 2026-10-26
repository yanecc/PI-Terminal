# Security model

This plugin runs commands on the user's machine and, with SSH, on other
machines. That is its purpose, so the job is not to make it harmless but to make
its power **visible, bounded and auditable**.

## Threat model

| Threat | Mitigation |
|---|---|
| A web page probing the loopback port | The stream requires a per-session bearer token minted in the plugin process; requests carrying `Origin` are refused; `Host` must be a loopback name (blocks DNS rebinding). |
| A malicious process on the same machine reading terminal output | It would need the token, which lives only in the plugin's memory and expires. |
| A MITM or a reinstalled server accepting a new host key silently | Two-phase verification: probe reads the key without sending credentials, `known_hosts` decides, and a **changed** fingerprint always refuses — there is no "ignore once". |
| Credentials leaking through logs or tool output | Passwords/passphrases are never logged, never returned by list calls, and never included in audit lines. Agent reads are redacted. File transfers never carry credentials: they ride the session's already-authenticated SSH connection. |
| A model running something destructive | Every tool that can put bytes into a shell, move files in either direction, or touch a saved connection (including delete) is `risk: high`, so the host asks the user before it runs. Reads are `low`; settings changes and opening a session are `medium`. |
| A model exfiltrating secrets it happened to see | `redactSecrets` runs on every read path; redaction counts are returned so the caller knows it happened. |
| A stuck helper process jamming shutdown | Each pty is a separate helper executable; ending the plugin kills it, and the OS reclaims its handles and threads. |

## Credentials

- **Private keys and ssh-agent are preferred.** A key file is read into memory
  for the connection and never copied anywhere.
- **Passwords are optional.** When saved they are encrypted at rest by the OS
  keystore: DPAPI (Windows), Keychain (macOS), libsecret (Linux). If none is
  available the plugin falls back to a local AES-256-GCM key file with `0600`
  permissions** and says so in the panel's Settings — a weaker backend must not look
  identical to a stronger one.
- **Reveal is deliberate and audited.** The eye button returns the plaintext for
  five seconds; that action writes a `profile.reveal` audit line.
- Passwords are decrypted only to open a connection or to answer a reveal.

## What is recorded

`<plugin data>/audit.jsonl` records: session open/exit, SSH host-key decisions,
profile save/delete/reveal, agent `send`/`upload`/`download`/`open`/`close`, agent
settings/profile changes, and plugin load/unload.

It never records terminal content and never records credentials. Keys matching
`pass*|secret|token|privateKey` are replaced with `«redacted»` even if a caller
passes them by mistake.

## Permissions, and why each one exists

| Permission | Why |
|---|---|
| `ui.view` | the work-panel terminal page |
| `net.fetch` | the loopback output stream (declared as `127.0.0.1`) |
| `agent.tool.register` | the eight terminal tools (read/send/wait/upload/download + session/profile/setting) |
| `clipboard.read` / `clipboard.write` | paste and copy in the terminal |
| `notify` | background session events |

Expected install warnings: `net.local-domain` (a loopback host is by definition a
local service) and `permission.high-risk` (agent tools). Both are accurate.

## Deliberate non-goals

- No shell-content persistence: buffers live in memory and die with the process.
- No "trust this key anyway" button for a changed fingerprint.
- No silent credential fallback: if the keystore is unavailable, Settings says
  which weaker backend is in use.
- No telemetry, no third-party server.
