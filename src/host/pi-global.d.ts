/**
 * 宿主注入的 `pi` 全局的类型声明。
 *
 * 只声明本插件真正用到的成员（`plugin` / `workspace` / `commands` / `agent` /
 * `ui`）。宿主 API 比这大得多，但把没用到的部分也抄一遍只会让类型文件随宿主
 * 版本漂移而失真 —— 需要新能力时再显式加一行，是一个有意的成本。
 */

declare global {
  // eslint-disable-next-line no-var
  var pi: PiApi;
}

export interface PiPluginApi {
  getId(): string;
  getManifest(): Record<string, unknown>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(partial: Record<string, unknown>): Promise<void>;
  getDataPath(): Promise<string>;
}

export interface PiWorkspaceApi {
  get(): Promise<{ path?: string; name?: string; roots?: Array<{ path: string; name?: string }>; projectId?: string } | null>;
}

export interface PiCommandDefinition {
  id: string;
  title: string;
  category?: string;
  keywords?: string[];
  run: () => Promise<void> | void;
}

export interface PiCommandsApi {
  register(command: PiCommandDefinition): Promise<void>;
  unregister(id: string): Promise<void>;
}

export interface PiToolDefinition {
  name: string;
  description?: string;
  risk?: "low" | "medium" | "high";
  schema?: unknown;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface PiAgentApi {
  registerTool(tool: PiToolDefinition): Promise<void>;
  unregisterTool(name: string): Promise<void>;
}

export interface PiUiApi {
  showToast(message: string, level?: "info" | "error" | "warning"): Promise<void>;
  notify(input: { title: string; body?: string }): Promise<void>;
}

export interface PiApi {
  plugin: PiPluginApi;
  workspace: PiWorkspaceApi;
  commands: PiCommandsApi;
  agent: PiAgentApi;
  ui: PiUiApi;
}

export {};
