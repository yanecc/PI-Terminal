/**
 * 插件主进程入口。
 *
 * 宿主 sidecar 的契约只有三个钩子：`onLoad` / `onUnload` / `onPanelInvoke`。
 * 这里负责把它们接到已验证过的模块上，并且**保持入口无逻辑** —— 入口一旦
 * 开始写业务，可测试性就会立刻下降。
 *
 * 生命周期：
 *   onLoad   读设置 → 打开数据目录 → 加载档案/凭据 → 起回环流 → 注册命令与工具
 *   onUnload 关会话 → 停回环流 → 注销工具与命令
 *
 * 任何一步失败都不得让插件「静默半死」：会退回一个可解释的降级状态
 * （例如回环端口起不来时仍可用控制面读取），并在 `term.ping` 里如实报告。
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppSettings, SessionSummary, SshProfile } from "../protocol.js";
import { AuditLog } from "./audit.js";
import { createChannels } from "./channels.js";
import { createSessionFactory, probeSshProfile } from "./factory.js";
import { RelayServer } from "./relay/server.js";
import { SessionRegistry } from "./sessions.js";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.js";
import { SecretStore } from "./ssh/secrets.js";
import { ProfileStore } from "./ssh/profiles.js";
import { buildTools } from "./tools/index.js";
import { listInstalledFamilies } from "./fonts.js";
import { normalizeProfileInput } from "./ssh/profiles.js";
import type { SshTransport } from "./transport/ssh.js";
import { manifest as PLUGIN_MANIFEST } from "../manifest.js";
import { downloadVia, uploadVia } from "./ssh/sftp.js";

// 从 manifest 取，避免两处硬编码各自漂移（审计日志里曾长期显示 0.1.3 而
// manifest 已是 0.1.4，排查时极具误导性）。
const VERSION = PLUGIN_MANIFEST.version;

interface PluginState {
  dataDir: string;
  settings: AppSettings;
  registry: SessionRegistry;
  relay: RelayServer;
  profiles: ProfileStore;
  secrets: SecretStore;
  audit: AuditLog;
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  /** 重新从宿主读设置（宿主的设置页随时可能改值）。 */
  refreshSettings: () => Promise<AppSettings>;
  /** 设置读写（模型工具用）：读、改、重置共用同一份真源。 */
  settingsApi: {
    read: () => Promise<AppSettings>;
    defaults: AppSettings;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
    reset: (keys?: string[]) => Promise<AppSettings>;
  };
  /** 档案增删（模型工具用）。 */
  saveProfile: (input: Record<string, unknown>) => Promise<SshProfile>;
  deleteProfile: (id: string) => Promise<boolean>;
  /** 命令面板用：关闭全部会话，返回关掉的数量。 */
  closeAllSessions: () => Promise<number>;
  /** 命令面板用：把全部设置恢复默认。 */
  resetAllSettings: () => Promise<AppSettings>;
  /** 连接自检：探一次 SSH 连接后立刻断开，**不占会话名额**。 */
  probeProfile: (profileId: string) => Promise<{ fingerprint: string }>;
  /** 已注册的工具名，卸载时逐个注销。 */
  registeredTools: string[];
  /** 已注册的命令 id。 */
  registeredCommands: string[];
}

let state: PluginState | null = null;
/**
 * 待用户决策的主机指纹 → **一组**等待者。
 *
 * 为什么是一组而不是一个回调：同一台未知主机可能被并发连接（用户连点两下、
 * 或面板与模型工具同时开会话）。旧实现用 `Map<key, 回调>`，后一个请求直接
 * 覆盖前一个，于是一次「信任」只能唤醒一个连接，另一个必然等到 20 秒超时 ——
 * 用户看到的是「点了信任还是连不上」。
 *
 * 现在同一个 fingerprint 下的所有连接一起被唤醒：对同一个指纹的决策本来就该
 * 是同一个答案。
 */
const pendingHostKey = new Map<string, Set<(accepted: boolean) => void>>();
/**
 * 插件运行时数据目录。
 *
 * ── 这个回落曾经造成一个真实故障 ──────────────────────────────────────────
 * 旧代码在 `getDataPath()` 失败时退回 `process.cwd()`，也就是**插件自己的安装
 * 目录**。PI-Desktop 会递归监视 development 插件目录（只豁免
 * node_modules/.git/dist/target），并在 300ms 防抖后重载插件。于是插件每写一次
 * 审计日志就成了「源码被改动」，宿主弹出 "Reloaded …"、销毁视图、终端内容随之
 * 清空 —— 表现就是「打开终端 Tab 偶尔自动重载然后变空白」。
 *
 * 所以这里的原则是：**运行时数据绝不写进安装目录**。拿不到数据目录时退到系统
 * 临时目录（同样不在监视树内），而不是 cwd。
 */
async function resolveDataDir(): Promise<string> {
  const fromEnv = process.env.PI_TERMINAL_DATA_DIR?.trim();
  try {
    const fromHost = await pi.plugin.getDataPath();
    if (fromHost && fromHost.trim()) return fromHost;
  } catch {
    // 落到临时目录。
  }
  return join(tmpdir(), "pi-terminal-data");
}

/**
 * 从宿主读一次设置。
 *
 * ── 这里曾是一个真实故障 ─────────────────────────────────────────────────
 * 宿主的「插件 - 设置」页把值**直接写进** `<插件数据>/settings.json`
 * （`pi.plugin.getSettings()` 每次调用都重新读盘），并且只给插件进程发一个
 * `plugin:settingsChanged` 事件 —— Node 侧的 `pi` 全局没有对应的订阅入口。
 * `plugin:settingsChanged` 事件 —— Node 侧的 `pi` 全局没有对应的订阅入口。
 * 旧代码只在 `onLoad` 读一次、之后永远用这份缓存：用户在设置页把默认 Shell
 * 改成 `nu`，新建终端仍按旧值（空串 → 自动探测 → PowerShell）启动，看上去
 * 就是「设置不生效」。
 *
 * 所以原则是：**真正要用设置的那一刻才读**，缓存只在读失败时兜底。
 */
async function readHostSettings(fallback: AppSettings = DEFAULT_SETTINGS): Promise<AppSettings> {
  try {
    return sanitizeSettings(await pi.plugin.getSettings());
  } catch {
    return fallback;
  }
}

export async function onLoad(): Promise<void> {
  const dataDir = await resolveDataDir();
  await mkdir(dataDir, { recursive: true });

  const settings = await readHostSettings();

  const audit = await AuditLog.open(dataDir);
  const secrets = await SecretStore.open(dataDir);
  const profiles = await ProfileStore.open(dataDir, secrets);

  let current: AppSettings = settings;
  const registry = new SessionRegistry(
    createSessionFactory({
      settings: () => current,
      dataDir,
      profiles,
      secrets,
      workspaceRoot: async () => (await pi.workspace.get().catch(() => null))?.path ?? null,
      askHostKey: (input) => requestHostKey(input.host, input.port, input.fingerprint),
      audit: (event, detail) => void audit.write(event, detail),
    }),
    { maxSessions: current.maxSessions, bufferBytes: current.bufferBytes, coalesceMs: 8 },
  );

  // 先创建：设置变更时要广播给已打开的面板（见 applySettings）。
  const relay = new RelayServer(registry);

  /**
   * 连接自检。**故意不进注册表**：见 factory.probeSshProfile 里的说明 ——
   * 自检占会话名额，会让「终端开满时测试连接」报出一条与 SSH 无关的 LIMIT，
   * 用户会以为主机连不上。
   */
  const probeProfile = async (profileId: string): Promise<{ fingerprint: string }> => {
    await refreshSettings();
    const profile = profiles.get(profileId);
    if (!profile) {
      throw Object.assign(new Error(`no such connection profile: ${profileId}`), { code: "NOT_FOUND" });
    }
    return probeSshProfile(
      profile,
      {
        dataDir,
        profiles,
        settings: () => current,
        askHostKey: (input) => requestHostKey(input.host, input.port, input.fingerprint),
        audit: (event, detail) => void audit.write(event, detail),
      },
      { cols: 80, rows: 24 },
    );
  };

  /**
   * 重新读设置，并让「会话名额 / 缓冲大小」跟着更新。
   *
   * 注册表在构造时把限额复制了进去；设置能在运行期改，不重设的话用户把上限从
   * 8 调到 16 仍然会拿到「最多 8 个」。缓冲只影响之后新建的会话（见
   * SessionRegistry.configure）。
   */
  const refreshSettings = async (): Promise<AppSettings> => {
    current = await readHostSettings(current);
    registry.configure({ maxSessions: current.maxSessions, bufferBytes: current.bufferBytes });
    return current;
  };
  /**
   * 写入设置（面板通道与模型工具共用）。
   *
   * 平铺写入：宿主的 settings.json 是一张扁平键值表；曾经写成 `{ settings: next }`，
   * 于是文件里多出一个嵌套的 `settings` 键，之后读回时顶层的旧值与嵌套里的新值会打架。
   * 顺便把「会话名额 / 缓冲大小」推给注册表，让改动对之后新建的会话立刻生效。
   */
  const applySettings = async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const next = sanitizeSettings({ ...current, ...patch });
    current = next;
    registry.configure({ maxSessions: next.maxSessions, bufferBytes: next.bufferBytes });
    await pi.plugin.setSettings({ ...next });

    // relayEnabled 是「开关一个端口」而不是一个纯数值：只在 onLoad 里判断一次的话，
    // 改这个设置就必须重启宿主才生效。
    if (next.relayEnabled && !relay.running) {
      try {
        await relay.start();
        await audit.write("relay.start", { port: null, trigger: "settings" });
      } catch (error) {
        await audit.write("relay.fail", { message: messageOf(error) });
      }
    } else if (!next.relayEnabled && relay.running) {
      await relay.stop().catch(() => undefined);
      await audit.write("relay.stop", { trigger: "settings" });
    }

    // 推给已打开的面板：宿主没有「插件 → 面板」的通道，但这条回环流是常驻的。
    // 没有这一步，模型改字体要重开面板才看得见 —— 而面板自己改则是本地下发。
    relay.broadcast({ t: "settings", settings: next });
    return next;
  };

  /** 重置：不给 keys 就整体回到默认值。 */
  const resetSettings = async (keys?: string[]): Promise<AppSettings> => {
    const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    if (!keys || keys.length === 0) return applySettings(DEFAULT_SETTINGS);
    const patch: Record<string, unknown> = {};
    for (const key of keys) patch[key] = defaults[key];
    return applySettings(patch as Partial<AppSettings>);
  };

  /**
   * 「把设置全部恢复默认」—— 命令面板与模型工具共用这一个入口。
   *
   * 必须走 applySettings（而不是直接写 settings.json）：只有那条路会同时更新
   * 会话限额、启停回环端口，并把新值广播给已打开的面板。
   */
  const resetAllSettings = async (): Promise<AppSettings> => {
    await audit.write("settings.resetAll", {});
    return resetSettings();
  };

  /**
   * 命令面板用的「关闭全部」与「设置恢复默认」。
   *
   * 两个命令都是**跨会话的批量动作**，所以它们和面板走同一段实现：
   *   · closeAll  → registry.closeAll()（会清掉 active、释放 transport）；
   *   · resetAll  → applySettings(DEFAULT_SETTINGS)（顺带更新限额、启停回环端口、
   *                 并把新值广播给已打开的面板）。
   * 命令里不复制这些逻辑，避免出现「命令改了、面板没改」的第二套语义。
   */
  const closeAllSessions = async (): Promise<number> => {
    const count = registry.liveCount();
    await registry.closeAll();
    await audit.write("command.closeAll", { closed: count });
    return count;
  };
  /** 档案写入：与面板共用同一段归一化，避免两处校验漂移。 */
  const saveProfile = (input: Record<string, unknown>) => profiles.save(normalizeProfileInput(input));

  const openSession = async (input: {
    kind: "local" | "ssh";
    cols: number;
    rows: number;
    profileId?: string;
    title?: string;
    cwd?: string;
  }): Promise<SessionSummary> => {
    // 打开会话前重新读一次设置：defaultShell / defaultCwdMode 都在这里被用到。
    await refreshSettings();
    const profile = input.profileId ? profiles.get(input.profileId) ?? undefined : undefined;
    if (input.kind === "ssh" && !profile) {
      throw Object.assign(new Error(`no such connection profile: ${input.profileId}`), { code: "NOT_FOUND" });
    }
    return registry.open({
      kind: input.kind,
      cols: input.cols,
      rows: input.rows,
      profile,
      title: input.title,
    });
  };

  const invoke = createChannels({
    registry,
    profiles,
    secrets,
    relay,
    // 视图问「设置是什么」时现拉一次：用户可能刚在宿主设置页改过值。
    settings: () => refreshSettings(),
    // 字体族枚举：字体是本机属性，由插件自己读（见 host/fonts.ts）。
    listFonts: () => listInstalledFamilies(),
    updateSettings: (patch) => applySettings(patch),
    openSession,
    transportOf: (sessionId) => {
      const summary = registry.get(sessionId);
      if (!summary || summary.kind !== "ssh") return null;
      const transport = registryTransport(registry, sessionId);
      return asSshTransport(transport);
    },
    requestHostKeyDecision: async (input) => {
      // 控制面无法主动弹窗（宿主没有向插件推送），所以这里只登记「待确认」，
      // 等视图通过 `term.hostkey.decide` 回填；20s 无回应按拒绝处理。
      return requestHostKey(input.host, input.port, input.fingerprint);
    },
    audit: (event, detail) => void audit.write(event, detail),
    version: VERSION,
    probeProfile,
  });

  const next: PluginState = {
    dataDir,
    settings: current,
    registry,
    relay,
    profiles,
    secrets,
    audit,
    invoke,
    refreshSettings,
    settingsApi: { read: () => refreshSettings(), defaults: DEFAULT_SETTINGS, update: applySettings, reset: resetSettings },
    saveProfile,
    closeAllSessions,
    resetAllSettings,
    probeProfile,
    deleteProfile: (id) => profiles.remove(id),
    registeredTools: [],
    registeredCommands: [],
  };

  // 先落到 state 再注册命令与工具：注册失败也要能 onUnload 回收。
  state = next;

  // 回环流是「输出通道」的加速器而不是前提：起不来也能用控制面读取。
  if (current.relayEnabled) {
    try {
      await relay.start();
      await audit.write("relay.start", { port: relay["port"] ?? null });
    } catch (error) {
      console.warn("[pi-terminal] loopback relay unavailable:", messageOf(error));
      await audit.write("relay.fail", { message: messageOf(error) });
    }
  }

  // 用局部引用而不是 `state`：它的类型是可空的，而这里刚赋值、必然存在。
  await registerCommands(next);
  await registerTools(next);
  await audit.write("plugin.load", { version: VERSION, backend: secrets.getStatus().backend });
}

export async function onUnload(): Promise<void> {
  const current = state;
  state = null;
  if (!current) return;

  await current.registry.closeAll().catch(() => undefined);
  await current.relay.stop().catch(() => undefined);
  for (const name of current.registeredTools) {
    await pi.agent.unregisterTool(name).catch(() => undefined);
  }
  for (const id of current.registeredCommands) {
    await pi.commands.unregister(id).catch(() => undefined);
  }
  await current.audit.write("plugin.unload", {}).catch(() => undefined);
}

/**
 * 宿主转发面板通道的入口。
 *
 * 注意：这里**不能**抛异常 —— 宿主会把异常变成一次失败的面板调用，视图拿不到
 * 结构化的错误码。所以所有失败都是返回值。
 */
export async function onPanelInvoke(channel: string, payload: unknown): Promise<unknown> {
  const current = state;
  if (!current) {
    return { ok: false, code: "INTERNAL", message: "the terminal plugin is not loaded" };
  }
  // 主机指纹的最终决定必须回到正在等待的那次连接上，而不是只记一笔审计。
  if (channel === "term.hostkey.decide") {
    const payloadRecord = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const host = typeof payloadRecord.host === "string" ? payloadRecord.host : "";
    const port = Number(payloadRecord.port) || 22;
    const fingerprint = typeof payloadRecord.fingerprint === "string" ? payloadRecord.fingerprint : "";
    if (host && fingerprint) {
      const delivered = resolveHostKeyDecision(host, port, fingerprint, payloadRecord.accepted === true);
      await current.audit.write("hostkey.decide", { host, port, fingerprint, accepted: payloadRecord.accepted === true, delivered });
      return { ok: true, delivered };
    }
  }
  return current.invoke(channel, payload);
}

/* ── 命令与工具注册 ───────────────────────────────────────────────────── */

async function registerCommands(current: PluginState): Promise<void> {
  /**
   * 命令面板只保留两个**真正通用**的入口：
   *
   *   · Close All Sessions —— 开满标签之后唯一有用的那个动作；
   *   · Reset All Settings —— 把改乱的设置一次性拉回默认。
   *
   * 为什么砍掉 Open / New Local / New SSH：面板里已经有同名按钮，命令面板再放
   * 一份只会让人在两个地方之间猜；而「新建本地」还依赖面板当前的尺寸，从命令
   * 发起的会话只能用一个猜来的 100×30，远不如点面板里的按钮。
   */
  const definitions = [
    {
      id: "pi-terminal.closeAll",
      title: "PI-Terminal: Close All Sessions",
      keywords: ["close", "all", "关闭", "全部"],
      run: async () => {
        const count = await current.closeAllSessions();
        await pi.ui.showToast(`Closed ${count} terminal session(s)`, "info").catch(() => undefined);
      },
    },
    {
      id: "pi-terminal.resetSettings",
      title: "PI-Terminal: Reset All Settings",
      keywords: ["reset", "settings", "default", "重置", "设置"],
      run: async () => {
        try {
          // 与面板里的「重置为默认值」走同一条写入路径（一次 applySettings），
          // 所以同样会推给已打开的面板（回环流广播 + 轮询兜底）。
          const next = await current.resetAllSettings();
          await current.audit.write("command.resetSettings", { keys: Object.keys(next).length });
          await pi.ui.showToast("PI-Terminal settings restored to their defaults", "info").catch(() => undefined);
        } catch (error) {
          await pi.ui.showToast(`Could not reset the settings: ${messageOf(error)}`, "error").catch(() => undefined);
        }
      },
    },
  ];

  for (const definition of definitions) {
    try {
      await pi.commands.register({
        id: definition.id,
        title: definition.title,
        keywords: definition.keywords,
        category: "PI-Terminal",
        run: definition.run,
      });
      current.registeredCommands.push(definition.id);
    } catch (error) {
      console.warn(`[pi-terminal] command ${definition.id} failed to register:`, messageOf(error));
    }
  }
}

async function registerTools(current: PluginState): Promise<void> {
  const tools = buildTools({
    registry: current.registry,
    profiles: current.profiles,
    audit: (event, detail) => void current.audit.write(event, detail),
    settings: current.settingsApi,
    saveProfile: current.saveProfile,
    deleteProfile: current.deleteProfile,
    openSession: async (input) => {
      // 工具建会话也走「现读设置」：否则模型那边会用启动时的旧 defaultShell。
      await current.refreshSettings();
      const session = await current.registry.open({
        kind: input.kind,
        cols: 100,
        rows: 30,
        profile: input.profileId ? current.profiles.get(input.profileId) ?? undefined : undefined,
        title: input.title,
        // 只有本地会话接受显式工作目录与 shell（SSH 的目录与 shell 都由远端决定）。
        cwd: input.kind === "local" ? input.cwd : undefined,
        shell: input.kind === "local" ? input.shell : undefined,
      });
      return { id: session.id };
    },
    // 连接自检：不占会话名额（见 probeProfile）。
    probeProfile: current.probeProfile,
    // 上传/下载都借用户**已经建立的那条** SSH 连接：同一个 ssh2 Client，不再握手
    // 一次、不再问一次主机指纹。具体走 put / fastPut / uploadDir 由 ssh/sftp.ts 决定。
    uploadToSession: async (sessionId, request) => {
      const ssh = asSshTransport(registryTransport(current.registry, sessionId));
      if (!ssh) return null;
      return ssh.withSftp((sftp) => uploadVia(sftp, request));
    },
    downloadFromSession: async (sessionId, request) => {
      const ssh = asSshTransport(registryTransport(current.registry, sessionId));
      if (!ssh) return null;
      return ssh.withSftp((sftp) => downloadVia(sftp, request));
    },
  });

  for (const tool of tools) {
    try {
      await pi.agent.registerTool({
        name: tool.declaration.name,
        description: tool.declaration.description,
        risk: tool.declaration.risk,
        schema: tool.declaration.schema,
        execute: (args: Record<string, unknown>) => tool.execute(args ?? {}),
      });
      current.registeredTools.push(tool.declaration.name);
    } catch (error) {
      console.warn(`[pi-terminal] tool ${tool.declaration.name} failed to register:`, messageOf(error));
    }
  }
}

/**
 * 取回某个会话的底层 transport。
 *
 * SessionRegistry 有意不把 transport 暴露给工具层（避免绕过状态机直接写），
 * 但文件传输需要一个真实的通道。这里通过一个受控的访问器拿到它，并在拿不到时
 * 返回 null 让调用方降级（工具侧变成 UNSUPPORTED）。
 */
function registryTransport(registry: SessionRegistry, sessionId: string): unknown {
  return registry.transportFor(sessionId);
}

/** 只有 SSH transport 有 SFTP 通道；本地 transport 没有 `withSftp`。 */
function asSshTransport(value: unknown): SshTransport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { kind?: unknown; withSftp?: unknown };
  if (candidate.kind !== "ssh" || typeof candidate.withSftp !== "function") return null;
  return value as SshTransport;
}

/**
 * 主机指纹询问：控制面没有「宿主 → 插件」的推送，所以这里只能等视图主动
 * 把决定发回来（`term.hostkey.decide`）。为了让连接不无限挂起，默认在
 * 20s 后按拒绝处理 —— 拒绝是安全的那一侧。
 */
function requestHostKey(host: string, port: number, fingerprint: string): Promise<boolean> {
  const key = `${host}:${port}:${fingerprint}`;
  return new Promise<boolean>((resolve) => {
    const waiters = pendingHostKey.get(key) ?? new Set();
    pendingHostKey.set(key, waiters);

    const waiter = (accepted: boolean): void => {
      clearTimeout(timer);
      resolve(accepted);
    };
    waiters.add(waiter);

    const timer = setTimeout(() => {
      // 超时只摘掉**自己**这个等待者：同组里别的连接可能已经被用户确认过了。
      waiters.delete(waiter);
      if (waiters.size === 0) pendingHostKey.delete(key);
      resolve(false);
    }, 20_000);
    timer.unref?.();
  });
}

/**
 * **仅供测试**：把「登记一次待确认」暴露出来，让脚本能在不启动整个插件的情况下
 * 复现「多条连接等同一个指纹」的场景（scripts/hostkey-concurrent-check.mjs）。
 * 生产路径只有 `askHostKey` → `requestHostKey` 一个入口。
 */
export const requestHostKeyForTest = requestHostKey;

/**
 * 供 `term.hostkey.decide` 调用（视图确认后回填）。
 *
 * 一次决策唤醒**同指纹的全部等待者**，并清空该键 —— 对同一个指纹的答案本就
 * 只有一个。返回是否真的有人被唤醒（没有的话说明已超时或重复提交）。
 */
export function resolveHostKeyDecision(host: string, port: number, fingerprint: string, accepted: boolean): boolean {
  const key = `${host}:${port}:${fingerprint}`;
  const waiters = pendingHostKey.get(key);
  if (!waiters || waiters.size === 0) return false;
  pendingHostKey.delete(key);
  for (const waiter of [...waiters]) waiter(accepted);
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DEFAULT_SETTINGS };
