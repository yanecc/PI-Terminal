/**
 * SSH 传输层（ssh2）。
 *
 * 职责边界：
 *   - 只负责「建立一条带 PTY 的 shell 通道并双向搬运字节」；
 *   - 凭据由 ssh/credentials.ts 解开后传进来，本文件不记录、不回传；
 *   - 主机指纹校验在这里完成，且**一定早于认证**。
 *
 * ── 指纹校验为什么是两阶段 ────────────────────────────────────────────────
 * ssh2 的 `hostVerifier` 是**同步**回调，而「首次连接要问用户」是异步的。
 * 常见的错误写法是在里面 `return true` 然后事后补问 —— 那时密码/私钥已经
 * 交给对端了，拦不拦都没意义。
 *
 * 因此这里分两步：
 *   探测连接：hostVerifier 一律 `return false`。该回调发生在密钥交换阶段、
 *             早于用户认证，所以连接会被 ssh2 主动断开，**凭据一个字节都没发**。
 *             我们只从回调里取出原始 host key 做指纹。
 *   正式连接：用户已确认（或 known_hosts 已信任）后，用同一指纹做严格比对，
 *             一致才允许完成握手与认证。
 */

import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";
import type SftpClient from "ssh2-sftp-client";

import type { OpenOptions, Transport, TransportEvents } from "./types.js";
import { withSftp } from "../ssh/sftp.js";
import { KnownHosts, fingerprintOf } from "../ssh/known-hosts.js";
import type { SshProfile } from "../../protocol.js";

export interface SshCredentials {
  password?: string;
  passphrase?: string;
  privateKey?: Buffer;
  /** agent socket 路径；缺省用 SSH_AUTH_SOCK。 */
  agentSocket?: string;
}

export interface SshHooks {
  /**
   * 首次见到某主机（或用户需要复核）时调用。返回 true 表示信任并写 known_hosts。
   * 指纹**变化**时不会调用它——变化一律拒绝，只能由用户手动删旧条目。
   */
  onHostKey: (input: { host: string; port: number; fingerprint: string }) => Promise<boolean>;
  onProgress?: (stage: "probe" | "tcp" | "auth" | "shell") => void;
}

export class SshTransport implements Transport {
  readonly kind = "ssh" as const;
  private closed = false;
  private cwd = "";

  private constructor(
    private readonly client: Client,
    private readonly stream: ClientChannel,
    private readonly upstream: Client[],
    readonly fingerprint: string,
  ) {}

  static async open(
    profile: SshProfile,
    credentials: SshCredentials,
    options: OpenOptions,
    events: TransportEvents,
    hooks: SshHooks,
    knownHosts: KnownHosts,
  ): Promise<SshTransport> {
    const host = profile.host;
    const port = profile.port || 22;

    // ── 第 1 步：探测指纹（不发送任何凭据）───────────────────────────────
    //
    // ── 有跳板时**不能**在这里直连目标 ─────────────────────────────────────
    // 旧实现无论有没有跳板都先在本地探最终目标：只能经跳板访问的目标（内网机器、
    // 防火墙后）在这一步就超时，整条链路直接失败 —— 跳板配置形同虚设。
    // 现在分两种：没有跳板 → 本地探（行为不变）；有跳板 → 跳过，等隧道建立后再探。
    const jumpCount = (profile.jump ?? []).length;
    let expected: string;
    let targetSock: ClientChannel | undefined;
    if (jumpCount === 0) {
      hooks.onProgress?.("probe");
      const probe = await probeHostKey(host, port);
      const decision = knownHosts.verify(host, port, probe.rawKey, probe.keyType);

      if (decision.status === "changed") {
        throw new Error(
          `host key for ${host}:${port} changed (was ${decision.previous}, now ${decision.fingerprint}). ` +
            "Refusing to connect: the server may have been reinstalled, or the connection is being intercepted. " +
            "If you know why it changed, remove the old entry and connect again.",
        );
      }
      if (decision.status === "unknown") {
        const accepted = await hooks.onHostKey({ host, port, fingerprint: decision.fingerprint });
        if (!accepted) throw new Error(`host key for ${host}:${port} was not accepted`);
        await knownHosts.add(host, port, probe.rawKey, probe.keyType);
      }
      expected = decision.fingerprint;
    } else {
      // 目标是哪一台要到隧道打通后才说得清，先放一个不可能匹配的占位值：
      // 真正连接用的是下面隧道里探测出来的指纹。
      expected = "";
    }

    // ── 第 2 步：跳板链 + 正式连接（严格比对同一指纹）─────────────────────
    //
    // ── 跳板链为什么必须「先连上、再往下探」──────────────────────────────
    // 旧实现先在**本地**探测最终目标的指纹、再用跳板机自己的地址建隧道，于是：
    //   · 只能经跳板访问的目标永远探测失败（本地根本连不上它）；
    //   · 隧道被转发到跳板机自身，而不是下一跳，链形同虚设；
    //   · 最终目标的指纹也从未在那条隧道里被校验过。
    // 现在每一跳都沿**上一跳的隧道**去探测下一跳：第 0 跳从本地探，第 N 跳经
    // 第 N-1 跳的 forwardOut 探，最终目标同理。跳板机本身仍然是一跳一跳校验的，
    // 「它是跳板机所以可以跳过校验」这种豁免不存在。
    const upstream: Client[] = [];
    try {
      for (const hop of profile.jump ?? []) {
        const hopPort = hop.port || 22;
        const previousHop = upstream[upstream.length - 1];
        const probeSock = previousHop ? await forwardOut(previousHop, hop.host, hopPort) : undefined;
        let hopProbe: ProbeResult;
        try {
          hopProbe = await probeHostKey(hop.host, hopPort, 15_000, probeSock);
        } finally {
          probeSock?.close();
        }
        const hopDecision = knownHosts.verify(hop.host, hopPort, hopProbe.rawKey, hopProbe.keyType);
        if (hopDecision.status === "changed") {
          throw new Error(
            `host key for jump host ${hop.host}:${hopPort} changed (was ${hopDecision.previous}, now ${hopDecision.fingerprint}). Refusing to connect.`,
          );
        }
        if (hopDecision.status === "unknown") {
          const accepted = await hooks.onHostKey({
            host: hop.host,
            port: hopPort,
            fingerprint: hopDecision.fingerprint,
          });
          if (!accepted) throw new Error(`host key for jump host ${hop.host} was not accepted`);
          await knownHosts.add(hop.host, hopPort, hopProbe.rawKey, hopProbe.keyType);
        }

        const hopClient = new Client();
        const hopSock = previousHop ? await forwardOut(previousHop, hop.host, hopPort) : undefined;
        await connectStrict(hopClient, hopCredentialsFor(profile, hop, credentials, hopSock), {
          host: hop.host,
          port: hopPort,
          expected: hopDecision.fingerprint,
        });
        upstream.push(hopClient);
      }

      // 最终目标：只有在有跳板时才需要经隧道再探一次（无跳板时第 1 步已经探过）。
      // 隧道里那次探测才是权威的：目标可能只有跳板能访问，本地那次根本走不通。
      if (upstream.length > 0) {
        const lastHop = upstream[upstream.length - 1]!;
        hooks.onProgress?.("probe");
        // 探测与正式连接各用一条隧道：SSH 握手读取过的通道不能重用于第二次握手。
        const probeSock = await forwardOut(lastHop, host, port);
        let finalProbe: ProbeResult;
        try {
          finalProbe = await probeHostKey(host, port, 15_000, probeSock);
        } finally {
          probeSock.close();
        }
        const finalDecision = knownHosts.verify(host, port, finalProbe.rawKey, finalProbe.keyType);
        if (finalDecision.status === "changed") {
          throw new Error(
            `host key for ${host}:${port} changed (was ${finalDecision.previous}, now ${finalDecision.fingerprint}). ` +
              "Refusing to connect: the server may have been reinstalled, or the connection is being intercepted.",
          );
        }
        if (finalDecision.status === "unknown") {
          const accepted = await hooks.onHostKey({ host, port, fingerprint: finalDecision.fingerprint });
          if (!accepted) throw new Error(`host key for ${host}:${port} was not accepted`);
          await knownHosts.add(host, port, finalProbe.rawKey, finalProbe.keyType);
        }
        expected = finalDecision.fingerprint;
        // 正式连接用另一条新隧道。
        targetSock = await forwardOut(lastHop, host, port);
      }

      const client = new Client();
      const config = buildConfig(profile, credentials, targetSock, options.keepaliveSeconds);
      await connectStrict(client, config, { host, port, expected });
      hooks.onProgress?.("shell");


      const stream = await openShell(client, profile, options);
      const transport = new SshTransport(client, stream, upstream, expected);

      stream.on("data", (chunk: Buffer | string) =>
        events.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      // stderr 与 stdout 在真实终端里是同一条流，合并而不是丢弃。
      stream.stderr.on("data", (chunk: Buffer | string) =>
        events.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on("close", (code: number | null) => {
        if (transport.closed) return;
        transport.closed = true;
        events.onExit(code ?? null);
        transport.dispose();
      });
      stream.on("error", (error: Error) => events.onError(error));
      client.on("error", (error: Error) => {
        if (!transport.closed) events.onError(error);
      });

      return transport;
    } catch (error) {
      for (const hop of upstream) safeEnd(hop);
      throw error;
    }
  }

  write(data: Buffer): void {
    if (this.closed) return;
    this.stream.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    this.stream.setWindow(rows, cols, 0, 0);
  }


  /**
   * 在已认证的连接上跑一条短命令并取回 stdout。
   *
   * 只用于「问一次远端状态」（当前目录），不用于执行用户输入 —— 用户输入永远走
   * ptyshell 那条路。带硬超时：拿不到就返回空，绝不挂住会话建立。
   */
  exec(command: string, timeoutMs = 4000): Promise<string> {
    if (this.closed) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (value: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(""), timeoutMs);
      timer.unref?.();
      try {
        this.client.exec(command, (error, stream) => {
          if (error) return finish("");
          let out = "";
          stream.setEncoding("utf8");
          stream.on("data", (chunk: string) => (out += chunk));
          stream.on("end", () => finish(out));
          stream.on("error", () => finish(""));
          stream.stderr?.setEncoding?.("utf8");
          stream.stderr?.on("data", () => undefined);
        });
      } catch {
        finish("");
      }
    });
  }

  async kill(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stream.close();
    } catch {
      /* 已断开 */
    }
    this.dispose();
  }

  async probeCwd(): Promise<string> {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * 借这条**已认证**的连接跑一段 SFTP 操作（实现见 ssh/sftp.ts）。
   *
   * 传输层只提供「通道」：上传还是下载、走 fastPut 还是 put，全部由调用方通过
   * ssh2-sftp-client 的 API 决定。这里不处理文件语义，也就不会出现第二套遍历/
   * 重试逻辑。用完只关子系统通道，连接与它承载的终端保持不动。
   */
  withSftp<T>(run: (sftp: SftpClient) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("session is closed"));
    return withSftp(this.client, run);
  }

  private dispose(): void {
    for (const hop of this.upstream) safeEnd(hop);
    safeEnd(this.client);
  }
}

/* ── 探测 ──────────────────────────────────────────────────────────────── */

interface ProbeResult {
  rawKey: Buffer;
  fingerprint: string;
  /** 服务器选的算法（`ssh-ed25519` / `ssh-rsa` / …），用于 known_hosts 的同类型比较。 */
  keyType: string;
}

/**
 * 只握手到「拿到 host key」为止，然后立刻断开。
 * 关键：`hostVerifier` 返回 false，因此 ssh2 不会继续认证流程。
 *
 * `sock` 不为空时**经已有隧道**探测：这是跳板链唯一可行的做法 —— 目标往往只能
 * 从跳板机访问，本地直连必然超时。
 */
function probeHostKey(host: string, port: number, timeoutMs = 15_000, sock?: ClientChannel): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    const client = new Client();
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error: Error | null, value?: ProbeResult): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      /*
       * ── 只关「自己打开的连接」，绝不关别人的隧道 ────────────────────────
       * `sock` 是上一跳留下的通道，后面正式连接还要用它。探测连接结束时若调用
       * `client.end()`，ssh2 会把它挂载的 sock 一并销毁 —— 于是出现「指纹探测
       * 成功、紧接着正式握手卡死」。没有 sock 时才由我们关这条 TCP 连接。
       */
      if (!sock) safeEnd(client);
      if (error) reject(error);
      else if (value) resolve(value);
    };

    timer = setTimeout(() => finish(new Error(`host key probe for ${host}:${port} timed out`)), timeoutMs);

    client.on("error", (error: Error & { level?: string }) => {
      // 「Host denied」正是我们主动拒绝造成的，不是故障。
      if (/host denied|verification failed/i.test(error.message)) {
        finish(
          new Error(
            `could not read the host key for ${host}:${port} (${error.message}). ` +
              "Check the host, port and any ProxyJump before retrying.",
          ),
        );
        return;
      }
      finish(new Error(describeSshError(error, host, port)));
    });

    client.on("ready", () => {
      // 探测连接不该走到认证成功；走到这里说明校验没生效，按失败处理。
      finish(new Error("host key probe unexpectedly completed a login; refusing to continue"));
    });

    const connectOptions: ConnectConfig = {
      host,
      port,
      username: "pi-terminal-probe",
      readyTimeout: timeoutMs,
      // 没有可用凭据，认证必然失败；我们只关心 hostVerifier 被调用。
      // ssh2 的类型要求回调参数与库一致，这里用类型注释借用其声明。
      authHandler: ((_methods: unknown, _partial: unknown, next: (name: never) => void) =>
        next(undefined as never)) as unknown as NonNullable<ConnectConfig["authHandler"]>,
      hostVerifier: (key: Buffer) => {
        const raw = Buffer.isBuffer(key) ? key : Buffer.from(key);
        finish(null, { rawKey: raw, fingerprint: fingerprintOf(raw), keyType: keyTypeOf(raw) });
        return false;
      },
    };
    if (sock) connectOptions.sock = sock;
    client.connect(connectOptions);
  });
}

/**
 * host key 的算法名。
 *
 * ssh2 的 `hostVerifier` 只给裸 key（wire format：4 字节长度 + 算法名 + 内容），
 * 算法名就在前几字节里，直接读出来比猜更可靠 —— known_hosts 的同类型比较依赖它。
 */
function keyTypeOf(rawKey: Buffer): string {
  if (rawKey.length < 4) return "unknown";
  const length = rawKey.readUInt32BE(0);
  if (length <= 0 || length > 64 || 4 + length > rawKey.length) return "unknown";
  return rawKey.subarray(4, 4 + length).toString("ascii");
}

/* ── 正式连接 ──────────────────────────────────────────────────────────── */

function connectStrict(
  client: Client,
  config: ConnectConfig,
  target: { host: string; port: number; expected: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      safeEnd(client);
      reject(error);
    };

    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    client.on("error", (error: Error) => fail(new Error(describeSshError(error, target.host, target.port))));

    let mismatched = false;
    client.connect({
      ...config,
      host: target.host,
      port: target.port,
      hostVerifier: (key: Buffer) => {
        const raw = Buffer.isBuffer(key) ? key : Buffer.from(key);
        const actual = fingerprintOf(raw);
        if (actual === target.expected) return true;
        // 不一致：拒绝握手，并给出可读原因（此时还没有发送任何凭据）。
        mismatched = true;
        fail(
          new Error(
            `host key for ${target.host}:${target.port} does not match the expected fingerprint ` +
              `(expected ${target.expected}, got ${actual}). Refusing to connect.`,
          ),
        );
        return false;
      },
    });

    void mismatched;
  });
}

function buildConfig(
  profile: SshProfile,
  credentials: SshCredentials,
  sock: ClientChannel | undefined,
  defaultKeepaliveSeconds?: number,
): ConnectConfig {
  const config: ConnectConfig = {
    username: profile.user,
    readyTimeout: 25_000,
    // 优先级：主机档案自己的 keepaliveSeconds > 设置里的全局值 > 20s。
    // （之前只读档案，设置里的 sshKeepaliveSeconds 实际上从来没生效过。）
    keepaliveInterval: Math.max(5, profile.keepaliveSeconds ?? defaultKeepaliveSeconds ?? 20) * 1000,
    keepaliveCountMax: 3,
  };
  if (sock) config.sock = sock;

  if (profile.auth === "agent") {
    config.agent = credentials.agentSocket || process.env.SSH_AUTH_SOCK || undefined;
    if (!config.agent) {
      throw new Error(
        "no ssh-agent is available. Start one (or set SSH_AUTH_SOCK), or switch this profile to key/password.",
      );
    }
  } else if (profile.auth === "key") {
    if (!credentials.privateKey) throw new Error("this profile needs a private key that can be read");
    config.privateKey = credentials.privateKey;
    if (credentials.passphrase) config.passphrase = credentials.passphrase;
  } else {
    if (!credentials.password) throw new Error("this profile needs a saved or provided password");
    config.password = credentials.password;
    config.tryKeyboard = true;
  }
  return config;
}

/**
 * 跳板机的连接配置。
 *
 * `sock` 是**上一跳留下的隧道**：第二跳起必须经它才能到达（与 OpenSSH 的
 * ProxyJump 链一致）。第一跳传 undefined，直接从本机连。
 */
function hopCredentialsFor(
  profile: SshProfile,
  hop: NonNullable<SshProfile["jump"]>[number],
  credentials: SshCredentials,
  sock?: ClientChannel,
): ConnectConfig {
  const config: ConnectConfig = {
    username: hop.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  };
  if (hop.auth === "agent") {
    const agent = credentials.agentSocket || process.env.SSH_AUTH_SOCK;
    if (agent) config.agent = agent;
  } else if (hop.auth === "key") {
    if (credentials.privateKey) config.privateKey = credentials.privateKey;
    if (credentials.passphrase) config.passphrase = credentials.passphrase;
  } else if (credentials.password) {
    config.password = credentials.password;
    config.tryKeyboard = true;
  }
  // 跳板机的 host 字段在调用处覆盖。
  config.host = hop.host;
  config.port = hop.port || 22;
  // 第二跳起一律经上一跳的隧道；这是 ProxyJump 链之所以成立的关键。
  if (sock) config.sock = sock;
  void profile;
  return config;
}

async function openShell(
  client: Client,
  profile: SshProfile,
  options: OpenOptions,
): Promise<ClientChannel> {
  const cols = options.cols;
  const rows = options.rows;
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: profile.term || "xterm-256color", cols, rows }, (error, channel) => {
      if (error) reject(new Error(describeSshError(error, profile.host, profile.port || 22)));
      else resolve(channel);
    });
  });
  if (profile.initialCommand) {
    stream.write(`${profile.initialCommand}\n`);
  }
  return stream;
}

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
      if (error) reject(new Error(`cannot open a tunnel to ${host}:${port}: ${error.message}`));
      else resolve(stream);
    });
  });
}

function describeSshError(error: Error & { code?: string }, host: string, port: number): string {
  const code = error.code;
  const base = `ssh ${host}:${port}: ${error.message}`;
  if (code === "ECONNREFUSED") return `${base} (connection refused — is sshd running?)`;
  if (code === "ENOTFOUND") return `${base} (host not found)`;
  if (code === "ETIMEDOUT") return `${base} (timed out — check the network or firewall)`;
  if (/authentication/i.test(error.message)) return `${base} (the server rejected these credentials)`;
  return base;
}

function safeEnd(client: Client): void {
  try {
    client.end();
  } catch {
    /* 已断开 */
  }
}
