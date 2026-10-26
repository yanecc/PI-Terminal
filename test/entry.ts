/**
 * 测试入口：只导出**纯逻辑**模块。
 * 任何需要真实 pty / 真实 SSH / 真实 DOM 的东西都不在这里；
 * DOM 行为由 scripts/view-behavior.mjs 在真实 Chromium 里验证。
 */
export { RingBuffer, redactSecrets, REDACTED } from "../src/host/ring-buffer.js";
export { parseKnownHosts, fingerprintOf, hostKeyName } from "../src/host/ssh/known-hosts.js";
export { encodeEvent, EventDecoder } from "../src/host/relay/protocol.js";
export { sanitizeSettings, DEFAULT_SETTINGS } from "../src/host/settings.js";
export { expandHome } from "../src/host/ssh/profiles.js";
export { resolveBase } from "../src/view/theme.js";
export { buildEnv, mergePathLists, expandEnvRefs, powershellModuleRoots } from "../src/host/env.js";
export { resolveShell } from "../src/host/transport/local.js";
export { resolveLocale, t, setLocale, messagesFor } from "../src/view/i18n.js";
export { groupProfiles } from "../src/view/profiles.js";
export { normalizeFamilies } from "../src/host/fonts.js";
export { coerceSettingsPatch, SETTINGS_KEYS } from "../src/host/settings.js";
export { normalizeProfileInput } from "../src/host/ssh/profiles.js";
export { SessionRegistry } from "../src/host/sessions.js";
export { pickMonospaceFamilies } from "../src/view/fonts.js";
export { KnownHosts } from "../src/host/ssh/known-hosts.js";
