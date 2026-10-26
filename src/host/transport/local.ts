/**
 * 本地 pty 适配器（fancy-pty）。
 *
 * 为什么是 fancy-pty 而不是 node-pty：helper 是可执行文件而非 .node addon，
 * 没有 ABI 耦合、没有 node-gyp、没有 electron-rebuild；插件一旦退出，helper
 * 作为独立进程被系统回收，不会把 commit/句柄留在宿主进程里。
 *
 * 一个必须讲清的点：helper 的路径解析由 fancy-pty 自己做（会把 `.asar` 段
 * 换成 `.asar.unpacked`）。插件是**目录**安装的，所以这里只需要在开会话前
 * 明确校验一次「文件存在且可执行」，缺失时报可操作的错误，而不是让用户看到
 * 一个 ENOENT 堆栈。
 */

import { delimiter, dirname, isAbsolute, join } from "node:path";
import { chmodSync, existsSync, statSync } from "node:fs";

import { helperFileName, isSupported, open as openPty, platformKey, unpackedPath } from "@particle-academy/fancy-pty";


import type { OpenOptions, Transport, TransportEvents } from "./types.js";

/** fancy-pty 的 Pty 句柄形状（只取我们真正用的部分，便于以后替换）。 */
interface PtyHandle {
  readonly pid: number | undefined;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  kill(graceMs?: number): Promise<void> | void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null, signal?: string) => void): void;
  onError?(cb: (error: Error) => void): void;
}

export class LocalTransport implements Transport {
  readonly kind = "local" as const;
  private readonly pty: PtyHandle;
  private killed = false;

  private constructor(pty: PtyHandle, private readonly cwd: string) {
    this.pty = pty;
  }

  /** 打开一个本地 pty。失败时抛出可读错误（不是 ENOENT 堆栈）。 */
  static async open(argv: string[], options: OpenOptions, events: TransportEvents): Promise<LocalTransport> {
    assertHelperAvailable();
    let pty: PtyHandle;
    try {
      pty = openPty({
        argv,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        // 显式给出 helper：默认解析基于 fancy-pty 自己的模块目录，而我们被
        // 内联进 `main.js`，那个目录变成了插件根，会去找 `<plugin>/bin/...`。
        helper: resolveHelperPath(),
        // env 显式传入（不合并）：pty 的环境正是我们构造的那份，
        // 不会因为宿主进程被怎么启动而出现不可复现的行为。
        env: options.env ?? (process.env as Record<string, string | undefined>),
      }) as unknown as PtyHandle;
    } catch (error) {
      throw new Error(`could not start a local terminal: ${messageOf(error)}`);
    }

    pty.onData((chunk) => events.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    pty.onExit((code, signal) => events.onExit(code ?? null, signal));
    pty.onError?.((error) => events.onError(error));

    return new LocalTransport(pty, options.cwd ?? process.cwd());
  }

  write(data: Buffer): void {
    if (this.killed) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.killed) return;
    this.pty.resize(cols, rows);
  }

  async kill(graceMs = 800): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    try {
      await this.pty.kill(graceMs);
    } catch {
      // helper 已经退出时 kill 会失败；这不是错误。
    }
  }

  async probeCwd(): Promise<string> {
    return this.cwd;
  }
}

/**
 * helper 是否可用。这是**启动期一次性**检查：缺 helper 是可行动的配置问题
 * （装错了包、asanUnpack 没生效、平台不支持），而不是运行期偶发故障。
 */
export function assertHelperAvailable(): void {
  if (!isSupported()) {
    throw new Error(
      `local terminals are not supported on ${process.platform}/${process.arch}: ` +
        "fancy-pty ships helpers for win32/darwin/linux on x64 and arm64 only",
    );
  }
  const exe = resolveHelperPath();
  if (!existsSync(exe)) {
    // 这条错误会原样出现在视图的状态条上，所以要写清「装错了什么、怎么修」。
    // 最常见的原因不是源码问题，而是安装时只拷了 main.js/views，漏掉了
    // node_modules —— 打包产物里是有 helper 的。
    throw new Error(
      `local terminals are unavailable: the pty helper is missing at ${exe}. ` +
        "This usually means the plugin was installed without its node_modules folder. " +
        "Reinstall from the packaged .piplug (it contains the helper), or point " +
        "PI_TERMINAL_PTY_HELPER at a fancy-pty helper executable.",
    );
  }
  ensureExecutable(exe);
}

/**
 * 保证 helper 可执行。
 *
 * ZIP 格式本身能记录 Unix 权限位，但**解包工具未必保留**：Windows 资源管理器、
 * 部分 Java/Go 解压实现都只还原数据不还原 mode。于是 macOS/Linux 用户会拿到一个
 * 0755 缺失的 helper，执行时报 EACCES —— 而这看起来像「插件装坏了」，用户根本
 * 想不到要手工 chmod。这里在每次建立会话前补一次权限：己有权限时是空操作，
 * 没有时静默修复，失败也不影响后续（由真正的 spawn 给出可读错误）。
 */
function ensureExecutable(exe: string): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(exe).mode;
    // 任意一个执行位存在就认为没问题，不去改动别人（可能是 setuid 场景）的设置。
    if ((mode & 0o111) !== 0) return;
    // 精确补「执行」位到与读位一致：保留原有 rw 位与特殊位，
    // 不要用 mode | 0o755 那种把权限整体改成 755 的写法（会顺手削掉 setuid/sticky）。
    const readBits = mode & 0o444;
    const execBits = (readBits >> 2) & 0o111;
    chmodSync(exe, mode | execBits | 0o100);
  } catch {
    // 只读挂载、无权限等：交给 spawn 去报真正的错误，这里不掩盖原因。
  }
}

/**
 * helper 的真实路径。
 *
 * 优先级：
 *   1. `PI_TERMINAL_PTY_HELPER` —— 排障/自定义安装时的手指。
 *   2. `<插件目录>/bin/<platform-arch>/fancy-pty-helper[.exe]` —— **发布形态**。
 *
 *      为什么放顶层而不是 node_modules：PI-Desktop 的安装器在把包内容拷进
 *      安装目录时会跳过名为 `node_modules` 的目录
 *      （host-core `copy_dir_filtered`：`if name_str == ".git" || name_str ==
 *      "node_modules" { continue; }`），而 `bin/` 不受影响。放在 node_modules
 *      里再正确的包，装到用户机器上也一定会缺 helper。
 *   3. `<插件目录>/node_modules/@particle-academy/fancy-pty/bin/<platform-arch>/…`
 *      —— 从源码目录直接跑、或用其它方式安装时可用的老位置。
 *   4. `.asar.unpacked` 变体（若插件被放进 asar）。
 *
 * 找不到时返回首选路径，让上层的报错信息里带着它。
 */
export function resolveHelperPath(): string {
  const override = process.env.PI_TERMINAL_PTY_HELPER?.trim();
  if (override) return override;

  const platform = platformKey();
  const fileName = helperFileName();
  // __dirname 在本 bundle 里就是插件安装目录。
  const candidates = [
    // 发布形态：顶层 bin/（安装器不会过滤这个目录名）。
    join(__dirname, "bin", platform, fileName),
    // 从源码目录直接跑、或旧式布局。
    join(__dirname, "node_modules", "@particle-academy", "fancy-pty", "bin", platform, fileName),
    unpackedPath(join(__dirname, "node_modules", "@particle-academy", "fancy-pty", "bin", platform, fileName)),
    // 开发态：脚本从仓库根目录启动时。
    join(__dirname, "..", "node_modules", "@particle-academy", "fancy-pty", "bin", platform, fileName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** 探测可用的 shell：设置里的路径优先，否则按平台顺序在子进程环境里查找。 */
export function resolveShell(
  configured: string,
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; source: string } {
  const preferred = configured.trim();
  if (preferred) {
    // 只接受绝对路径或「能在 PATH 里找到」的命令名，不接受带参数的一整行：
    // 拆分命令行引号是另一个雷区，交给用户显式指定解释器更安全。
    // 绝对路径里的空格是合法的（`C:\Program Files\PowerShell\7\pwsh.exe` 就是这样），
    // 只有「命令名 + 参数」写成一整行才必须拒绝：拆分命令行引号是另一个雷区。
    if (!isAbsolute(preferred) && !preferred.startsWith('"') && preferred.includes(" ")) {
      throw new Error(
        `default shell must be a path or a command name without arguments: ${preferred}`,
      );
    }
    // 用户填了命令名（例如 `powershell`）时，必须和自动探测走**同一条**解析路径：
    // 解析成绝对路径、并带上 PowerShell 需要的启动参数。
    //
    // 之前这里直接 `return { argv: [preferred] }`，于是设置里写 `powershell` 得到的是
    // `argv = ["powershell"]`：没有 `-NoLogo`，也不做任何校验。而留空时走下面的
    // findOnPath 分支，拿到的是 `[<abs path>, "-NoLogo"]`。同一个用户意图、两条
    // 完全不同的命令行 —— PowerShell 一侧的初始化差异（含 profile 加载失败时
    // 环境变量看起来「读不到」）就来自这个不一致。
    return { argv: resolveConfiguredShell(preferred, env), source: "settings" };
  }

  const candidates =
    process.platform === "win32"
      ? [
          ["powershell.exe", ["-NoLogo"]],
          ["pwsh.exe", ["-NoLogo"]],
          ["cmd.exe", []],
        ]
      : [[env.SHELL || "", []], ["/bin/zsh", []], ["/bin/bash", []], ["/bin/sh", []]] as Array<
          [string, string[]]
        >;

  for (const [command, args] of candidates as Array<[string, string[]]>) {
    if (!command) continue;
    if (isAbsolute(command)) {
      if (existsSync(command)) return { argv: [command, ...args], source: "detected" };
      continue;
    }
    const found = findOnPath(command, env);
    if (found) return { argv: [found, ...args], source: "detected" };
  }
  const fallback = process.platform === "win32" ? env.COMSPEC || "cmd.exe" : "/bin/sh";
  return { argv: [fallback], source: "fallback" };
}

/**
 * 把「设置里填的 shell」解析成完整命令行。
 *
 * 三条规则：
 *   1. 已经是绝对路径 → 原样使用（若它恰好是 PowerShell，仍补上启动参数）；
 *   2. 是命令名 → 在子进程 PATH 里解析成绝对路径，解析不到就报可读错误
 *      （而不是让 pty helper 在更深处抛一个没有上下文的 ENOENT）；
 *   3. PowerShell 家族统一加 `-NoLogo`：去掉启动横幅。
 *
 * 这样「设置里写 powershell」与「留空自动探测到 powershell」产出的命令行完全一致，
 * 不会出现「留空正常、显式填了就环境异常」这种不可解释的差异。
 */
function resolveConfiguredShell(
  preferred: string,
  env: Record<string, string | undefined>,
): string[] {
  const args = powershellArgsFor(preferred);
  if (isAbsolute(preferred)) {
    if (!existsSync(preferred)) {
      throw new Error(`the configured default shell does not exist: ${preferred}`);
    }
    return [preferred, ...args];
  }
  const found = findOnPath(preferred, env);
  if (!found) {
    throw new Error(
      `the configured default shell "${preferred}" was not found on PATH. ` +
        "Use an absolute path, or leave the setting empty to auto-detect.",
    );
  }
  return [found, ...(args.length ? args : powershellArgsFor(found))];
}

/** PowerShell / pwsh 需要 `-NoLogo`；其它 shell 不加参数。 */
function powershellArgsFor(shell: string): string[] {
  const base = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return /^(powershell|pwsh)(\.exe)?$/.test(base) ? ["-NoLogo"] : [];
}

function findOnPath(command: string, env: Record<string, string | undefined>): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? env.PathExt ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      // 用 join 而不是手拼 `${dir}/${name}`：PATH 条目在 Windows 上是 `C:\...`，
      // 手拼会产出 `C:\...\v1.0/powershell.exe` 这种混用分隔符的路径。虽然
      // Windows 接受它，但这种字符串会原样出现在 argv 与日志里，排障时刺眼。
      const exeName = command.toLowerCase().endsWith(ext.toLowerCase()) ? command : `${command}${ext}`;
      const candidate = join(dir, exeName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
