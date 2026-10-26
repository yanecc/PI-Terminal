/**
 * 会话工厂：把「本地 pty」与「SSH shell」接到 SessionRegistry 上。
 *
 * 这一层是唯一知道两种传输差异的地方。它的产物永远是 SessionRegistry 需要的
 * 形状（transport + 通过 handle 推输出），所以注册表、回环流、模型工具都不
 * 需要再分支。
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";

import type { SessionFactory, SessionHandle } from "./sessions.js";
import { LocalTransport, resolveShell } from "./transport/local.js";
import { buildEnv, systemVariablesError } from "./env.js";
import { SshTransport } from "./transport/ssh.js";
import { KnownHosts } from "./ssh/known-hosts.js";
import type { SecretStore } from "./ssh/secrets.js";
import type { ProfileStore } from "./ssh/profiles.js";
import type { AppSettings, SshProfile } from "../protocol.js";

export interface FactoryDeps {
  settings: () => AppSettings;
  dataDir: string;
  profiles: ProfileStore;
  secrets: SecretStore;
  workspaceRoot: () => Promise<string | null>;
  /** 首次连接某主机时的信任询问（由频道层弹给用户）。 */
  askHostKey: (input: { host: string; port: number; fingerprint: string }) => Promise<boolean>;
  /** 审计：建会话、SSH 指纹决策。 */
  audit: (event: string, detail: Record<string, unknown>) => void;
}

export function createSessionFactory(deps: FactoryDeps): SessionFactory {
  return async ({ kind, cols, rows, profile, cwd, shell, title, handle }) => {
    if (kind === "local") return openLocal(cols, rows, deps, handle, cwd, shell, title);
    if (!profile) throw new Error("an SSH session needs a connection profile");
    return openSsh(profile.id, cols, rows, deps, handle, title);
  };
}

async function openLocal(
  cols: number,
  rows: number,
  deps: FactoryDeps,
  handle: SessionHandle,
  cwdOverride?: string,
  shellOverride?: string,
  titleOverride?: string,
): Promise<{ transport: LocalTransport }> {
  const settings = deps.settings();
  const env = await buildEnv();
  // 调用方给的 shell 优先于设置里的默认值：两者走**同一条**解析路径（命令名 →
  // PATH 解析成绝对路径、绝对路径 → 校验存在、PowerShell 家族补 -NoLogo），
  // 所以「设置里留空」与「显式指定同一个 shell」得到的命令行完全一致。
  const { argv, source } = resolveShell(shellOverride?.trim() || settings.defaultShell, env);
  const cwd = await pickCwd(settings, deps, cwdOverride);

  const transport = await LocalTransport.open(argv, { cols, rows, cwd, env }, {
    onData: (chunk) => handle.push(chunk),
    onExit: (code) => {
      handle.setStatus("closed", code === 0 ? undefined : `exited with code ${code ?? "unknown"}`);
      deps.audit("session.exit", { kind: "local", code });
    },
    onError: (error) => handle.setStatus("failed", error.message),
  });

  // 标题优先级：调用方显式给的（模型工具的 title / 视图的标题）> 目录名 > shell 名。
  // 之前这里无条件用目录名，等于把自定义标题吃掉了。
  handle.describe({ title: titleOverride?.trim() || baseNameOf(cwd) || argv[0] || "local", cwd });
  // 审计里记下「实际交给 pty 的环境摘要」。
  //
  // 排「PowerShell profile 加载失败 / $Error.Count 非 0」这类问题时，关键是
  // 判断两件事：合并有没有跑、以及最终是哪几条模块目录。前者看
  // unexpandedVars，后者看 psModuleDirs。
  //
  // 只记**目录名**（最后一段），不记完整路径：足以定位是哪一条缺失
  // （WindowsPowerShell / Modules / scoop 一眼能认出来），又不把用户的
  // 目录结构写进日志。
  const psModulePath = env.PSModulePath ?? "";
  const psModuleDirs = psModulePath
    .split(";")
    .filter(Boolean)
    .map((entry) => entry.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "?");
  const pathValue = env.PATH ?? "";
  const pathList = pathValue.split(";").filter(Boolean);
  deps.audit("session.open", {
    kind: "local",
    shell: argv[0],
    shellSource: source,
    cwd,
    psModuleEntries: psModuleDirs.length,
    psModuleDirs,
    pathEntries: pathList.length,
    // profile 里依赖 scoop 的 shims（zoxide 就在那里）。这里是 false 就说明
    // PATH 合并没把用户级目录带进来 —— 那才是「zoxide 找不到」的正解。
    pathHasShims: pathList.some((entry) => /[\\/]shims$/i.test(entry)),
    // 与合并后对比：两者相等说明一条系统条目都没补上。
    inboundPathEntries: (process.env.PATH ?? "").split(";").filter(Boolean).length,
    // 有未展开的 %VAR% 说明合并没跑或读注册表失败——这是要排查的信号。
    unexpandedVars: /%[A-Za-z_][A-Za-z0-9_]*%/.test(psModulePath),
    // 进程环境里「进来时」就有几条：区分「合并前就很干净」和「合并补上了」。
    inboundPsModuleEntries: (process.env.PSModulePath ?? "").split(";").filter(Boolean).length,
    // 读注册表失败时这里会有值——它就是「合并为何没生效」的答案。
    systemVariablesError: systemVariablesError(),
  });
  return { transport };
}

async function openSsh(
  profileId: string,
  cols: number,
  rows: number,
  deps: FactoryDeps,
  handle: SessionHandle,
  titleOverride?: string,
): Promise<{ transport: SshTransport }> {
  const profile = deps.profiles.get(profileId);
  if (!profile) throw new Error(`no such connection profile: ${profileId}`);

  const credentials = await deps.profiles.credentials(profile);
  const knownHosts = await KnownHosts.load(deps.dataDir);

  const transport = await SshTransport.open(
    profile,
    credentials,
    { cols, rows, env: await buildEnv(), keepaliveSeconds: deps.settings().sshKeepaliveSeconds },
    {
      onData: (chunk) => handle.push(chunk),
      onExit: (code) => {
        handle.setStatus("closed", code === 0 ? undefined : `remote shell exited (${code ?? "unknown"})`);
        deps.audit("session.exit", { kind: "ssh", host: profile.host, code });
      },
      onError: (error) => handle.setStatus("failed", error.message),
    },
    {
      onHostKey: async (input) => {
        // 先把「等你在面板里确认」摆到会话摘要上，再挂起等待。
        //
        // 为什么必须这样：这次连接正被 `invoke` 堵着（它在等确认结果），视图那侧
        // 同一条调用链也拿不到任何东西。只有把待确认项塞进摘要，视图的 1 秒轮询
        // 才能看见它并弹窗；否则就是「双方互等到超时」。
        handle.describe({
          hostKeyPending: { host: input.host, port: input.port, fingerprint: input.fingerprint },
        });
        const accepted = await deps.askHostKey(input);
        // 不论接受与否都要清掉：确认框该关了，摘要里也不该留一个过期的待办。
        handle.describe({ hostKeyPending: null });
        deps.audit("ssh.hostkey", { host: input.host, port: input.port, fingerprint: input.fingerprint, accepted });
        return accepted;
      },
      onProgress: (stage) => {
        // 握手进度只写进会话状态，不刷屏：用户看到标签上的「连接中」即可。
        if (stage === "probe") handle.setStatus("starting", "verifying the host key");
        else if (stage === "auth") handle.setStatus("starting", "authenticating");
        else if (stage === "shell") handle.setStatus("starting", "opening a shell");
      },
    },
    knownHosts,
  );

  // ── 远端工作目录：必须真的问一次远端 ──────────────────────────────────
  //
  // 旧实现调用 `transport.probeCwd()`，而它只是返回 `this.cwd` —— 一个从未被赋值
  // 的字段（`setCwd()` 全仓库没有调用点），于是每个 SSH 会话的 cwd 恒为空，标签
  // 提示里永远是「unknown cwd」。
  //
  // 这里在同一条已认证连接上跑一次 `pwd`。失败不该拖垮连接：拿不到就用空串，
  // 界面照旧可用，只是不显示目录。
  const cwd = await queryRemoteCwd(transport).catch(() => "");
  transport.setCwd(cwd);

  handle.describe({
    title: titleOverride?.trim() || `${profile.user}@${profile.host}`,
    cwd,
    fingerprint: transport.fingerprint,
  });
  deps.audit("session.open", { kind: "ssh", host: profile.host, port: profile.port, auth: profile.auth });
  return { transport };
}

/**
 * 新会话的工作目录。
 *
 * 优先级：调用方显式给的 `cwd`（模型工具）> 设置里的默认（项目根目录 / 主目录）。
 * 显式 cwd 必须是**已存在的绝对路径**：pty 在目录不存在时会以 ENOENT 失败，
 * 那条错误对调用方毫无信息量；这里提前报清楚是哪条路径有问题。
 */

/**
 * 问一次远端的当前目录。
 *
 * 用 `pwd`（POSIX 与绝大多数 Windows OpenSSH 都认），失败就是空串。调用方自己
 * `catch`，所以这里不再吞异常之外的东西：网络断开时返回空，界面照常可用。
 */
async function queryRemoteCwd(transport: { exec: (command: string) => Promise<string> }): Promise<string> {
  const out = await transport.exec("pwd");
  return out.trim().split(/\r?\n/).pop()?.trim() ?? "";
}
async function pickCwd(settings: AppSettings, deps: FactoryDeps, override?: string): Promise<string> {
  if (override && override.trim()) {
    const candidate = override.trim();
    if (!isAbsoluteLocal(candidate)) {
      throw new Error(`cwd must be an absolute path: ${candidate}`);
    }
    const info = await stat(candidate).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`cwd is not an existing directory: ${candidate}`);
    }
    return candidate;
  }
  if (settings.defaultCwdMode === "home") return homedir();
  const root = await deps.workspaceRoot().catch(() => null);
  return root || homedir();
}

/** Windows 的 `C:\\x` 与 POSIX 的 `/x` 都算绝对路径。 */
function isAbsoluteLocal(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * 连接自检：走完「探测指纹 → 校验 known_hosts → 认证 → 打开 shell」，然后立刻关掉。
 *
 * ── 为什么不能复用 openSession ────────────────────────────────────────────
 * 旧实现把自检当成普通会话来开，于是它也要占一个会话名额：开满 8 个终端之后
 * 点「测试连接」，用户看到的是「at most 8 live sessions are allowed」——
 * 一条和 SSH 本身毫无关系的失败，既误导又没法自查。自检是**一次性的探测**，
 * 不是用户要用的终端，所以它不经过 SessionRegistry：不占名额、不出现在标签栏、
 * 也不需要 OutputChunk 流水线，输出直接丢弃。
 */
export async function probeSshProfile(
  profile: SshProfile,
  deps: Pick<FactoryDeps, "dataDir" | "profiles" | "settings" | "askHostKey" | "audit">,
  target: { cols: number; rows: number },
): Promise<{ fingerprint: string }> {
  const credentials = await deps.profiles.credentials(profile);
  const knownHosts = await KnownHosts.load(deps.dataDir);
  const transport = await SshTransport.open(
    profile,
    credentials,
    { cols: target.cols, rows: target.rows, keepaliveSeconds: deps.settings().sshKeepaliveSeconds },
    { onData: () => undefined, onExit: () => undefined, onError: () => undefined },
    {
      onHostKey: async (input) => {
        const accepted = await deps.askHostKey(input);
        deps.audit("ssh.hostkey", { host: input.host, port: input.port, fingerprint: input.fingerprint, accepted });
        return accepted;
      },
    },
    knownHosts,
  );
  try {
    return { fingerprint: transport.fingerprint };
  } finally {
    await transport.kill().catch(() => undefined);
  }
}
