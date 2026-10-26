/**
 * 设置的读写与校验。
 *
 * 设置存在 `pi.plugin.getSettings()/setSettings()`（宿主托管，随插件数据目录
 * 持久化）。`contributes.settings` 里声明的键是「设置页」的入口，但用户也可能
 * 直接改 JSON，因此**每次读取都要过一遍 sanitize**：类型错、范围错、未知值
 * 一律回落默认，绝不让一个坏值把终端变成不可用状态。
 */

import type { AppSettings } from "../protocol.js";

export const DEFAULT_SETTINGS: AppSettings = {
  defaultShell: "",
  defaultCwdMode: "workspace",
  scrollback: 5000,
  bufferBytes: 2 * 1024 * 1024,
  maxSessions: 8,
  fontSize: 13,
  fontFamily: "",
  cursorBlink: true,
  confirmMultilinePaste: true,
  relayEnabled: true,
  sshKeepaliveSeconds: 20,
};

export const DEFAULT_SHELL_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export function sanitizeSettings(raw: unknown): AppSettings {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    defaultShell: asString(input.defaultShell, DEFAULT_SETTINGS.defaultShell, 1024),
    defaultCwdMode: input.defaultCwdMode === "home" ? "home" : "workspace",
    scrollback: asInt(input.scrollback, DEFAULT_SETTINGS.scrollback, 100, 50_000),
    bufferBytes: asInt(input.bufferBytes, DEFAULT_SETTINGS.bufferBytes, 256 * 1024, 8 * 1024 * 1024),
    maxSessions: asInt(input.maxSessions, DEFAULT_SETTINGS.maxSessions, 1, 16),
    fontSize: asInt(input.fontSize, DEFAULT_SETTINGS.fontSize, 8, 28),
    fontFamily: asString(input.fontFamily, "", 256),
    cursorBlink: asBool(input.cursorBlink, DEFAULT_SETTINGS.cursorBlink),
    confirmMultilinePaste: asBool(input.confirmMultilinePaste, DEFAULT_SETTINGS.confirmMultilinePaste),
    relayEnabled: asBool(input.relayEnabled, DEFAULT_SETTINGS.relayEnabled),
    sshKeepaliveSeconds: asInt(input.sshKeepaliveSeconds, DEFAULT_SETTINGS.sshKeepaliveSeconds, 5, 300),
  };
}

function asString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
/** 设置项的键（单一真源：模型工具的入参校验与 sanitize 都用它）。 */
export const SETTINGS_KEYS = [
  "defaultShell",
  "defaultCwdMode",
  "scrollback",
  "bufferBytes",
  "maxSessions",
  "fontSize",
  "fontFamily",
  "cursorBlink",
  "confirmMultilinePaste",
  "relayEnabled",
  "sshKeepaliveSeconds",
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/**
 * 把「外部提交的设置补丁」校验成可用的部分设置。
 *
 * 与 `sanitizeSettings` 的分工：sanitize 是**宽容**的（坏值静默回落默认，用于读盘），
 * 这里是**严格**的（只为模型工具服务）：类型错、键名未知一律进 `problems` 让调用方
 * 自己纠正，而不是把 `fontSize: "big"` 悄悄变成默认值。数值范围仍交给
 * sanitizeSettings 夹取 —— 那不是错误，只是越界。
 */
export function coerceSettingsPatch(raw: unknown): { patch: Partial<AppSettings>; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { patch: {}, problems: ["settings must be an object"] };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      problems.push(`unknown setting: ${key} (allowed: ${SETTINGS_KEYS.join(", ")})`);
      continue;
    }
    switch (key) {
      case "defaultShell":
      case "fontFamily":
        if (typeof value !== "string") problems.push(`${key} must be a string`);
        else patch[key] = value.trim();
        break;
      case "defaultCwdMode":
        if (value !== "workspace" && value !== "home") {
          problems.push('defaultCwdMode must be "workspace" or "home"');
        } else patch[key] = value;
        break;
      case "cursorBlink":
      case "confirmMultilinePaste":
      case "relayEnabled":
        if (typeof value !== "boolean") problems.push(`${key} must be a boolean`);
        else patch[key] = value;
        break;
      default:
        if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${key} must be a number`);
        else patch[key] = value;
    }
  }
  return { patch: patch as Partial<AppSettings>, problems };
}
