/**
 * 子进程环境构造。
 *
 * ── 为什么不能只 `{ ...process.env }` ─────────────────────────────────────
 * 终端里 `git` / `node` / `cargo` 找不到，最常见的原因不是这些程序没装，而是
 * **宿主进程的 PATH 不完整**。Windows 上尤其明显：
 *   · 从 Explorer / 开始菜单启动的 Electron 应用拿到的是「登录时」的环境快照，
 *     用户在本次登录后新装的工具（或新加的用户级 PATH 条目）不在里面；
 *   · 我们自己的 sidecar 是宿主 `fork` 出来的，它继承的又是这份快照。
 * 因此这里在构造环境时**主动合并系统 PATH**：注册表里的 Machine + User 两条
 * 权威值，与进程现有 PATH 做并集（保持进程里的顺序优先，避免打断用户已经
 * 调好的解析顺序）。这样「新装了一个 CLI，重开终端就能用」是成立的。
 *
 * 非 Windows 平台不做这件事：PATH 由登录 shell / launchd 决定，
 * 再读一份「系统 PATH」反而可能与用户的 shell 配置冲突。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 会把动态库/解释器加载行为改掉的变量：插件不提供覆盖入口。 */
const PROTECTED = ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"] as const;

/**
 * 宿主环境块被精简时，需要从注册表补回来的**基础 Windows 变量**。
 *
 * 实测审计里出现过 `inboundPsModuleEntries: 0` —— 宿主 sidecar 的
 * `process.env` 里连 `PSModulePath` 都没有，说明它拿到的是一份被裁剪过的环境，
 * 而不是用户登录时的完整快照。缺了这些变量，终端里会出现一批看似无关的怪现象：
 *   · 缺 `PATHEXT` → PowerShell 解析不到**无扩展名的命令名**，`zoxide` / `git`
 *     明明在 PATH 里也会报「无法识别为 cmdlet、函数、脚本文件」；
 *   · 缺 `SystemRoot` / `windir` → 许多程序（含 PowerShell 自身）行为异常；
 *   · 缺 `TEMP` / `APPDATA` / `USERPROFILE` → 工具写文件到奇怪位置或直接失败。
 *
 * 这些都是**环境事实**，不是策略：进程里已有值时绝不覆盖。
 */
const WINDOWS_BASIC_VARS = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ProgramData",
  "CommonProgramFiles",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "PUBLIC",
  "ALLUSERSPROFILE",
] as const;

/** 缓存注册表读取：走一次子进程，没必要每个会话都做。 */
const systemVariablesCache = new Map<string, Promise<Record<string, string>>>();
/**
 * 「读系统变量」失败的记录，**按变量名分别保存**。
 *
 * 这里曾经是一个单一字符串，结果是：PATH 读取失败、PSModulePath 读取成功时，
 * 后者会把前者的错误清掉 —— 审计里看到 `systemVariablesError: ""`，可实际上
 * PATH 根本没合并成功。用户因此拿到的是宿主那份残缺 PATH，终端里 `zoxide`
 * 之类来自 scoop shims 的命令全部「找不到」，而日志一片干净。
 *
 * 键是本次读取的变量名列表（与缓存键一致），值是失败原因。
 */
const systemVariablesErrors = new Map<string, string>();

export interface BuildEnvOptions {
  /** 额外环境（当前只用于「复用调用方显式设定的值」）。 */
  extra?: Record<string, string | undefined>;
  /**
   * 是否合并系统 PATH。默认 true；测试可关掉以免依赖宿主机注册表。
   */
  mergeSystemPath?: boolean;
}

/** Main-process environment availability only; do not expose environment values to the view. */
export function environmentDiagnostics(): {
  variableCount: number;
  path: boolean;
  temp: boolean;
  home: boolean;
  shell: boolean;
} {
  const entries = Object.entries(process.env);
  const hasValue = (...names: string[]): boolean =>
    entries.some(([key, value]) => names.includes(key.toLowerCase()) && Boolean(value));

  return {
    variableCount: entries.filter(([, value]) => typeof value === "string").length,
    path: hasValue("path"),
    temp: hasValue("temp", "tmp", "tmpdir"),
    home: hasValue("home", "userprofile"),
    shell: hasValue("shell", "comspec"),
  };
}

/** 构造子进程环境：继承 + 合并系统 PATH + 终端必需变量。 */
export async function buildEnv(options: BuildEnvOptions = {}): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env };
  const pathEntries = Object.entries(env).filter(([key]) => key.toLowerCase() === "path");
  let pathValue: string | undefined;
  for (const [, value] of pathEntries) {
    if (typeof value !== "string") continue;
    pathValue = pathValue === undefined ? value : mergePathLists(pathValue, value);
  }

  if (options.mergeSystemPath !== false) {
    const extraPath = await readSystemPath();
    if (extraPath) pathValue = mergePathLists(pathValue, extraPath);
  }

  // `PSModulePath` 与 PATH 同样重要，原因见 readSystemModulePath 的注释：
  // 缺了系统级那两条，PowerShell 交互式启动时连自己的模块都找不到，
  // 表现就是「只有 cmd 能读到环境变量」。这里用同一套合并规则补齐。
  let modulePathValue =
    env.PSModulePath ?? env.PsModulePath ?? env.psmodulepath ?? undefined;
  if (options.mergeSystemPath !== false) {
    const extraModules = await readSystemModulePath();
    if (extraModules) modulePathValue = mergePathLists(modulePathValue, extraModules);
  }
  // 兜底：PowerShell 自己那两条模块根**始终**补上。
  //
  // 这是最后一道保险。读注册表可能因为编码、stderr 噪音、注册表值异常等原因
  // 只拿到一部分条目（实测出现过只有 3 条、缺一条系统级目录的情况）；一旦缺了，
  // profile 里的 Import-Module 就会失败，用户看到的是「$Error.Count 非 0」和
  // 一堆看似无关的「找不到模块」。这两条路径是 PowerShell 自身的安装位置，
  // 由 SystemRoot 推导即可，不依赖任何外部读取。
  modulePathValue = mergePathLists(modulePathValue, powershellModuleRoots(env));

  if (process.platform === "win32" && options.mergeSystemPath !== false) {
    // 只在**进程里没有**时补：宿主或用户显式设过的值优先级更高。
    const basics = await readWindowsBasics();
    for (const [name, value] of Object.entries(basics)) {
      if (!value) continue;
      const alreadySet = Object.keys(env).some(
        (key) => key.toLowerCase() === name.toLowerCase() && (env[key] ?? "").length > 0,
      );
      if (alreadySet) continue;
      env[name] = expandEnvRefs(value);
    }
  }

  if (process.platform === "win32") {
    /*
     * 确定性兜底：这些值不需要任何外部读取就能算出来。
     *
     * 为什么还要这一层：`SystemRoot` / `ProgramFiles` / `ProgramData` 通常**不在**
     * 注册表里（由内核或安装器提供），所以上面的注册表补齐补不到它们；而一旦
     * `PATHEXT` 缺失，PowerShell 解析不到无扩展名的命令名 —— `zoxide`、`git`
     * 明明在 PATH 里也会报「无法识别为 cmdlet、函数、脚本文件」。
     * 这类值从 `SystemRoot` 的盘符推导即可，永远可用，因此放在最后兜底。
     */
    const setIfEmpty = (name: string, value: string | undefined): void => {
      if (!value) return;
      const has = Object.keys(env).some(
        (key) => key.toLowerCase() === name.toLowerCase() && (env[key] ?? "").length > 0,
      );
      if (!has) env[name] = value;
    };

    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const drive = /^[A-Za-z]:/.exec(systemRoot)?.[0] ?? "C:";
    setIfEmpty("SystemDrive", drive);
    setIfEmpty("SystemRoot", systemRoot);
    setIfEmpty("windir", systemRoot);

    // 命令名解析依赖它：没有 PATHEXT，`zoxide` 会被判成「找不到」。
    setIfEmpty("PATHEXT", ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC");
    const comspec = join(systemRoot, "system32", "cmd.exe");
    if (existsSync(comspec)) setIfEmpty("COMSPEC", comspec);

    const programFiles = `${drive}\\Program Files`;
    if (existsSync(programFiles)) {
      setIfEmpty("ProgramFiles", programFiles);
      setIfEmpty("ProgramW6432", programFiles);
      setIfEmpty("CommonProgramFiles", `${programFiles}\\Common Files`);
    }
    const programFiles86 = `${drive}\\Program Files (x86)`;
    if (existsSync(programFiles86)) setIfEmpty("ProgramFiles(x86)", programFiles86);
    const programData = `${drive}\\ProgramData`;
    if (existsSync(programData)) {
      setIfEmpty("ProgramData", programData);
      setIfEmpty("ALLUSERSPROFILE", programData);
    }
  }

  if (process.platform === "win32") {
    // CreateProcess receives a raw environment block; duplicate PATH/Path (and
    // PSModulePath in any casing) entries have undefined precedence. Normalize
    // each to exactly one canonical name before handing it to the pty.
    for (const key of Object.keys(env)) {
      const lower = key.toLowerCase();
      if (lower === "path" || lower === "psmodulepath") delete env[key];
    }
  }
  if (pathValue !== undefined) env.PATH = pathValue;
  if (modulePathValue) env.PSModulePath = modulePathValue;

  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "PI-Desktop";
  env.PI_TERMINAL = "1";

  for (const key of PROTECTED) {
    const value = options.extra?.[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform !== "win32") return env;

  // fancy-pty passes this object as a raw CreateProcess environment block, which
  // Windows expects to be sorted case-insensitively by variable name.
  return Object.fromEntries(
    Object.entries(env).sort(([left], [right]) => {
      const a = left.toUpperCase();
      const b = right.toUpperCase();
      return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
    }),
  );
}

/**
 * PATH 并集。
 *
 * 进程自己的条目排在前面（用户/工具主动 prepend 的目录优先），系统条目补齐。
 * 比较时在 Windows 上忽略大小写与结尾分隔符 —— `C:\Tools\` 与 `c:\tools`
 * 是同一条，重复追加只会让 PATH 无限增长。
 */
export function mergePathLists(current: string | undefined, extra: string): string {
  const keyword = process.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string): void => {
    // 展开 %VAR% 再判重：注册表里的值是 REG_EXPAND_SZ，PowerShell 进程常把
    // 未展开的字面量（`%ProgramFiles%\...`）原样带下来。若不展开：
    //   · 这条永远解析不到 → 对应的模块目录/PATH 目录实际不可用；
    //   · 与已展开的同名条目被当成两条不同路径 → PATH 越拼越长。
    const trimmed = expandEnvRefs(value.trim());
    if (!trimmed) return;
    // 展开后仍带 %VAR% 说明这个变量在子进程里根本不存在，丢弃该条目。
    if (process.platform === "win32" && /%[^%]+%/.test(trimmed)) return;
    const key = normalizeEntry(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const entry of (current ?? "").split(keyword)) push(entry);
  for (const entry of extra.split(keyword)) push(entry);
  return out.join(keyword);
}

function normalizeEntry(entry: string): string {
  const unified = entry.replace(/[\\/]+$/, "").replace(/\//g, "\\");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * 展开 `%NAME%` 形式的变量引用。
 *
 * 为什么需要：注册表里的 PATH / PSModulePath 是 `REG_EXPAND_SZ`，存的是
 * **未展开**的原始值（`%ProgramFiles%\WindowsPowerShell\Modules`）。多数读取
 * 方式会替你展开，但 PowerShell 进程自身的 `$env:PSModulePath` 常把未展开的
 * 那份原样传下来 —— 于是在进程环境里看到的就是字面量 `%ProgramFiles%`。
 *
 * 用户看到的症状：`$env:PSModulePath` 里列着
 * `%ProgramFiles%\WindowsPowerShell\Modules`（一条永远不存在的目录），同时
 * profile 里的 `Import-Module` 因为真正的模块目录没被解析到而失败，接着
 * `zoxide` 这类来自 shims 的命令也被报告为「找不到」。
 *
 * 规则：
 *   · 只认 `%NAME%`（Windows 惯例），不碰 `$NAME` / `${NAME}`；
 *   · 变量不存在时保持原样，由调用方决定是否丢弃；
 *   · 非 Windows 原样返回（`%` 在 POSIX 路径里是合法字符）。
 */
export function expandEnvRefs(value: string): string {
  if (process.platform !== "win32") return value;
  if (!value.includes("%")) return value;
  return value.replace(/%([^%]+)%/g, (whole, name: string) => lookupEnvInsensitive(name) ?? whole);
}

/** 进程环境是大小写不敏感的：`SystemRoot` 与 `SYSTEMROOT` 是同一个。 */
function lookupEnvInsensitive(name: string): string | null {
  const direct = process.env[name];
  if (typeof direct === "string") return direct;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === lower && typeof value === "string") return value;
  }
  return null;
}
/**
 * PowerShell 自带的两个模块根。
 *
 * 由 `SystemRoot` 推导，**不依赖任何外部读取**，所以永远可用。它们必须出现在
 * `PSModulePath` 里，否则 PowerShell 找不到自己的内置模块：
 *   · `%ProgramFiles%\WindowsPowerShell\Modules` —— 系统级第三方模块
 *   · `%SystemRoot%\system32\WindowsPowerShell\v1.0\Modules` —— PowerShell 内置模块
 *
 * 缺了后者时，`Import-Module` 对许多模块都会失败，用户 profile 里那几行
 * `Import-Module scoop-completion` / `gsudoModule` 会连锁报错，
 * 最终表现是「$Error.Count 非 0、命令找不到」。
 */
export function powershellModuleRoots(env: Record<string, string | undefined>): string {
  if (process.platform !== "win32") return "";
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  // ProgramFiles / ProgramW6432 在**精简过的环境块**里经常缺失（宿主的 sidecar
  // 可能只带 SystemRoot 之类的少数变量）。缺了就按 SystemRoot 的盘符推回去，
  // 否则这里会少一条系统级模块根 —— 正是 profile 里 Import-Module 失败的原因。
  // 候选路径先校验存在性，避免在非常规安装位置塞一条坏目录。
  const drive = /^[A-Za-z]:/.exec(systemRoot)?.[0] ?? "C:";
  const programFilesCandidates = [
    env.ProgramFiles,
    env.PROGRAMFILES,
    env.ProgramW6432,
    `${drive}\\Program Files`,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const roots: string[] = [];
  const programFilesRoot = programFilesCandidates
    .map((base) => join(base, "WindowsPowerShell", "Modules"))
    .find((candidate) => existsSync(candidate));
  if (programFilesRoot) roots.push(programFilesRoot);
  roots.push(join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"));
  return roots.join(";");
}
/**
 * 读注册表里的 Machine + User 环境变量值。
 *
 * 为什么用 PowerShell 的绝对路径而不是 `execFile("powershell", …)`：
 * 插件跑在宿主 fork 出来的 sidecar 进程里，那个进程的 PATH 是宿主启动时的
 * 快照 —— 恰好就是本模块要修的那个问题。如果 sidecar 的 PATH 里没有
 * System32（极少数精简/绿色版环境），`execFile("powershell")` 会以 ENOENT
 * 失败，于是合并静默失效，用户在终端里依旧找不到新装的 CLI。
 * 用绝对路径调用，只在绝对路径也不存在时才退回 PATH 查找。
 *
 * 失败一律返回 null：环境构造不能因为「读不到系统变量」让终端起不来。
 */
function readSystemVariables(names: string[]): Promise<Record<string, string>> {
  const cacheKey = names.join("|");
  const cached = systemVariablesCache.get(cacheKey);
  if (cached) return cached;

  const promise = new Promise<Record<string, string>>((resolve) => {
    // 每一项读 Machine 与 User 两条，用 `;` 连接：调用方随后会做去重合并。
    const script = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
      names
        .map(
          (name) =>
            `"${name}=" + (([Environment]::GetEnvironmentVariable('${name}','Machine'),` +
            `[Environment]::GetEnvironmentVariable('${name}','User')) -join ';');`,
        )
        .join(" "),
    ].join(" ");

    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    const absolute = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const candidates = existsSync(absolute) ? [absolute, "powershell"] : ["powershell", absolute];

    let index = 0;
    const attempt = (): void => {
      const command = candidates[index] ?? "powershell";
      index += 1;
      execFile(
        command,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          /*
           * 这里**不能**用 `if (!error)` 判断成功。
           *
           * execFile 的 `error` 非空有两种情况：进程真的失败，或者 stdout 没被
           * 正常收集。PowerShell 很容易踩到第二种：模块自动加载、编码、
           * ExecutionPolicy 的警告都会往 stderr 写；某些环境下 `-NoProfile`
           * 也挡不住 AllUsersAllHosts profile 报错。
           *
           * 一旦因此走到 `resolve({})`，合并会**静默失效** —— 终端里的 PATH /
           * PSModulePath 只剩宿主进程那份残缺快照，用户看到「少目录 +
           * Import-Module 失败」，插件却一声不响。这是最难查的那类故障。
           *
           * 判据改成「有没有可解析的输出」：有就用，没有才回退到下一个候选。
           */
          const parsed: Record<string, string> = {};
          for (const line of (stdout ?? "").split(/\r?\n/)) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
            if (match?.[1] && match[2] !== undefined) parsed[match[1]] = match[2].trim();
          }
          if (Object.keys(parsed).length > 0) {
            // 只清掉**本次这组变量**的失败记录，不要影响另一组（PATH / PSModulePath）。
            systemVariablesErrors.delete(cacheKey);
            resolve(parsed);
            return;
          }
          if (index < candidates.length) {
            attempt();
            return;
          }
          // 两个候选都没拿到输出：按变量名记下原因（会被写进 session.open 审计），
          // 这样「合并为何没生效」在日志里是可查的，而不是只能靠猜。
          systemVariablesErrors.set(
            cacheKey,
            error
              ? `${(error as NodeJS.ErrnoException).code ?? "ERROR"}: ${error.message}`
              : "the lookup produced no parsable output",
          );
          resolve({});
        },
      );
    };
    attempt();
  });

  systemVariablesCache.set(cacheKey, promise);
  return promise;
}

/**
 * 读一批基础 Windows 变量（Machine 优先，User 兜底）。
 *
 * 和 `readSystemVariables` 的区别：那个把 Machine/User 用 `;` 拼起来，给 PATH
 * 这类**列表**变量用；这里每个变量只需要**一个**最终值，不能拼接 —— `PATHEXT`
 * 若用 `;` 拼就会带上空项，反而让命令名解析失败。
 */
function readWindowsBasics(): Promise<Record<string, string>> {
  const cacheKey = "basics";
  const cached = systemVariablesCache.get(cacheKey);
  if (cached) return cached;

  const promise = new Promise<Record<string, string>>((resolve) => {
    const script = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
      WINDOWS_BASIC_VARS.map(
        (name) =>
          `"M.${name}=" + [string]([Environment]::GetEnvironmentVariable('${name}','Machine'));` +
          `"U.${name}=" + [string]([Environment]::GetEnvironmentVariable('${name}','User'));`,
      ).join(" "),
    ].join(" ");

    const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    const absolute = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const candidates = existsSync(absolute) ? [absolute, "powershell"] : ["powershell", absolute];

    let index = 0;
    const attempt = (): void => {
      const command = candidates[index] ?? "powershell";
      index += 1;
      execFile(
        command,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          const machine: Record<string, string> = {};
          const user: Record<string, string> = {};
          for (const line of (stdout ?? "").split(/\r?\n/)) {
            const match = /^([MU])\.([A-Za-z0-9_()]+)=(.*)$/.exec(line.trim());
            if (!match) continue;
            const scope = match[1];
            const name = match[2] ?? "";
            const value = (match[3] ?? "").trim();
            if (!name) continue;
            if (scope === "M") machine[name] = value;
            else user[name] = value;
          }
          if (Object.keys(machine).length > 0 || Object.keys(user).length > 0) {
            const merged: Record<string, string> = {};
            for (const name of WINDOWS_BASIC_VARS) {
              merged[name] = machine[name] || user[name] || "";
            }
            // SystemRoot 通常不在注册表里（由内核提供），用 windir 兜底。
            if (!merged.SystemRoot) merged.SystemRoot = merged.windir ?? "";
            // USERPROFILE 多数情况下也没有，用 HOMEDRIVE+HOMEPATH 拼出来。
            if (!merged.USERPROFILE && merged.HOMEDRIVE && merged.HOMEPATH) {
              merged.USERPROFILE = `${merged.HOMEDRIVE}${merged.HOMEPATH}`;
            }
            systemVariablesErrors.delete(cacheKey);
            resolve(merged);
            return;
          }
          if (index < candidates.length) {
            attempt();
            return;
          }
          systemVariablesErrors.set(
            cacheKey,
            error
              ? `${(error as NodeJS.ErrnoException).code ?? "ERROR"}: ${error.message}`
              : "the lookup produced no parsable output",
          );
          resolve({});
        },
      );
    };
    attempt();
  });

  systemVariablesCache.set(cacheKey, promise);
  return promise;
}

/** 读注册表里的 Machine + User PATH。 */
export async function readSystemPath(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const values = await readSystemVariables(["PATH"]);
  return values.PATH?.trim() || null;
}

/**
 * 读 `PSModulePath`（Machine + User）。
 *
 * 为什么它和 PATH 一样重要：PowerShell 交互式启动时会加载 profile 并把
 * `PSModulePath` 里列出的目录当作模块根。如果这个变量缺失或只剩用户级目录
 * （宿主从 Explorer 启动时常见：登录后新装/改过的用户级变量在快照里，而
 * 系统级那两条不在），PS 就找不到自己的内置模块，profile 加载报错、`$env:`
 * 里的东西看起来「读不到」—— 而 cmd 不依赖模块系统，于是表现为「只有 cmd
 * 能正常读环境变量」。
 */
export async function readSystemModulePath(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const values = await readSystemVariables(["PSModulePath"]);
  return values.PSModulePath?.trim() || null;
}

export function __resetSystemPathCache(): void {
  systemVariablesCache.clear();
  systemVariablesErrors.clear();
}

/**
 * 读系统变量失败的汇总（空字符串 = 全部成功）。
 *
 * 形态：`PATH: ENOENT: ...; PSModulePath: ...`。写进 `session.open` 审计后，
 * 「终端里少了目录」到底是系统里没配、还是插件没读到，一眼可分。
 *
 * 注意按变量**分别**报告：只要有一组失败就保留它的原因，不会被另一组成功
 * 覆盖掉 —— 这正是之前那个单一字符串版本的问题。
 */
export function systemVariablesError(): string {
  if (systemVariablesErrors.size === 0) return "";
  return [...systemVariablesErrors.entries()]
    .map(([names, reason]) => `${names}: ${reason}`)
    .join("; ");
}
