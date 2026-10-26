/**
 * 本机回环流服务。
 *
 * 为什么需要它：宿主转发面板自定义通道有 30s 超时，且**没有**宿主→插件的
 * 推送通道。终端输出是持续的，只能由视图主动「拉一条长连接」。
 *
 * 安全设计（这个端口对同机其它进程是可达的，必须当成不可信网络对待）：
 *   · 只监听 127.0.0.1，端口取临时端口（0），不写死；
 *   · 每个连接必须带 `Authorization: Bearer <token>`，token 由主进程内存生成、
 *     与 session 绑定、用完或超时即失效；
 *   · 校验 `Host` 头必须是回环地址（挡 DNS rebinding），并拒绝带 `Origin`
 *     的跨站请求（面板页是 file://，正常请求没有 Origin）；
 *   · 只暴露「读某个已存在会话」与「写某个已存在会话」两个动作，没有列目录、
 *     没有建会话，权限面比控制面窄。
 *
 * 断点续读：`?from=<seq>` 从环形缓冲里补齐，重连不会重复写屏。
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";

import type { SessionRegistry } from "../sessions.js";
import { encodeEvent } from "./protocol.js";
import type { RelayEvent } from "./protocol.js";
import type { RelayInfo } from "../../protocol.js";

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_MS = 20_000;
const MAX_INPUT_BYTES = 256 * 1024;

interface Grant {
  token: string;
  /** 这个令牌可以读的会话：一条复用连接通常覆盖全部活动会话。 */
  sessionIds: string[];
  expiresAt: number;
}

export class RelayServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;
  private readonly grants = new Map<string, Grant>();
  private readonly sockets = new Set<Socket>();
  /** 当前打开的流响应：广播全局事件（如设置变化）时用。 */
  private readonly streams = new Set<ServerResponse>();

  constructor(private readonly registry: SessionRegistry) {}

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.reply(res, 500, { ok: false, message: messageOf(error) });
      });
    });

    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("could not determine the loopback port");
    }
    this.port = address.port;
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        /* 已断开 */
      }
    }
    this.sockets.clear();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.grants.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * 广播一条与具体会话无关的事件（目前只有「设置变了」）。
   *
   * 为什么要走这条流：宿主侧没有「插件 → 面板」的推送通道，而这条回环流本来
   * 就是常驻的。不发这里，就只能等面板下次重载才看到新设置。
   */
  broadcast(event: RelayEvent): void {
    for (const res of this.streams) {
      try {
        res.write(encodeEvent(event));
      } catch {
        // 断开的连接由 res 的 close 事件清理。
      }
    }
  }

  /** 为某个会话签发一次性令牌（单会话场景，例如测试与旧调用方）。 */
  grant(sessionId: string): RelayInfo {
    return this.grantMany([sessionId]);
  }

  /**
   * 为**一组**会话签发一个令牌。
   *
   * 为什么是一组：浏览器对同一 host:port 的并发连接上限是 6，一会话一条长连接
   * 时第 7 个终端永远收不到数据（视图停在 connecting、seq 0）。视图改成一条复用
   * 连接后，令牌必须一次覆盖它要读的所有会话。
   */
  grantMany(sessionIds: string[]): RelayInfo {
    if (!this.server || this.port === 0) {
      throw new Error("the loopback relay is not running");
    }
    const unique = [...new Set(sessionIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (unique.length === 0) throw new Error("no session to stream");
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.grants.set(token, { token, sessionIds: unique, expiresAt });
    return { url: `http://127.0.0.1:${this.port}/v1/stream`, token, expiresAt };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.looksLocal(req)) {
      this.reply(res, 403, { ok: false, message: "forbidden host" });
      return;
    }
    // 浏览器带着 Origin 来通常是跨站页面在试探本机端口。
    if (req.headers.origin) {
      this.reply(res, 403, { ok: false, message: "cross-origin requests are not allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const grant = this.authorize(req.headers.authorization);
    if (!grant) {
      this.reply(res, 401, { ok: false, message: "invalid or expired token" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/stream") {
      this.stream(grant, url, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/input") {
      await this.input(grant, req, res);
      return;
    }
    this.reply(res, 404, { ok: false, message: "not found" });
  }

  private looksLocal(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!host) return false;
    const bare = host.replace(/:\d+$/, "");
    return bare === "127.0.0.1" || bare === "localhost" || bare === "[::1]";
  }

  private authorize(header: string | undefined): Grant | null {
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (grant.expiresAt <= Date.now()) {
      this.grants.delete(token);
      return null;
    }
    // 常量时间比较，避免用响应时间做令牌枚举。
    const left = Buffer.from(grant.token);
    const right = Buffer.from(token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    return grant;
  }

  /**
   * 长连接：一条响应承载**多个**会话（`?sessions=id:from,id:from`）。
   *
   * 复用是硬需求：浏览器对同一 host:port 的并发连接上限是 6，一会话一条长连接
   * 时第 7 个终端永远空白。复用后连接数恒为 1，与标签数量无关。
   */
  private stream(grant: Grant, url: URL, res: ServerResponse): void {
    const requested = this.requestedSessions(grant, url);
    if (requested.length === 0) {
      this.reply(res, 404, { ok: false, message: "no such session" });
      return;
    }

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });

    this.streams.add(res);
    let finished = false;
    let live = requested.length;
    const detachers: Array<() => void> = [];

    const heartbeat = setInterval(() => {
      if (!finished) res.write(encodeEvent({ t: "ping", at: Date.now() }));
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.streams.delete(res);
      clearInterval(heartbeat);
      for (const detach of detachers) detach();
      try {
        res.end();
      } catch {
        /* 已断开 */
      }
    };

    /** 一个会话收尾：告诉客户端它结束了；全部结束时关闭整条连接。 */
    const drop = (sessionId: string, reason: string): void => {
      live -= 1;
      if (!finished) res.write(encodeEvent({ t: "bye", session: sessionId, reason }));
      if (live <= 0) finish();
    };

    for (const target of requested) {
      const summary = this.registry.get(target.id);
      if (!summary) {
        live -= 1;
        continue;
      }

      res.write(encodeEvent({ t: "hello", session: target.id, seq: summary.seq, status: summary.status }));

      // 历史补齐：把 `from` 之后仍留在缓冲里的块按序发出。
      const from = target.from > 0 ? target.from : summary.seq + 1;
      const history = this.registry.read(target.id, from, 8 * 1024 * 1024);
      for (const chunk of history.chunks) {
        res.write(encodeEvent({ t: "data", session: target.id, seq: chunk.seq, data: chunk.data }));
      }

      // 会话已经结束：补完历史就收尾，不让视图空等。
      if (summary.status === "closed" || summary.status === "failed") {
        drop(target.id, summary.status);
        continue;
      }

      let done = false;
      const unsubscribe = this.registry.subscribe(target.id, (event) => {
        if (done || finished) return;
        if (event.type === "data") {
          // 只推送历史之后的块，避免重复。
          if (event.chunk.seq >= history.nextSeq) {
            res.write(encodeEvent({ t: "data", session: target.id, seq: event.chunk.seq, data: event.chunk.data }));
          }
          return;
        }
        res.write(encodeEvent({ t: "status", session: target.id, status: event.status, message: event.message }));
        if (event.status === "closed" || event.status === "failed") {
          done = true;
          unsubscribe();
          drop(target.id, event.status);
        }
      });
      detachers.push(() => {
        done = true;
        unsubscribe();
      });
    }

    if (live <= 0) finish();

    res.on("close", finish);
    res.on("error", finish);
  }

  /** 解析 `?sessions=id:from,...`；没有该参数时退化为单会话 `?from=`。 */
  private requestedSessions(grant: Grant, url: URL): Array<{ id: string; from: number }> {
    const raw = url.searchParams.get("sessions");
    if (!raw) {
      const id = grant.sessionIds[0];
      if (!id || !this.registry.has(id)) return [];
      const from = Math.floor(Number(url.searchParams.get("from") ?? 0)) || 0;
      return [{ id, from }];
    }
    const allowed = new Set(grant.sessionIds);
    const out: Array<{ id: string; from: number }> = [];
    for (const part of raw.split(",")) {
      const [id, from] = part.split(":");
      if (!id || !allowed.has(id) || !this.registry.has(id)) continue;
      out.push({ id, from: Math.floor(Number(from)) || 0 });
    }
    return out;
  }
  /** 写入：视图按键走这里，避免每次按键都发一次 IPC。 */
  private async input(grant: Grant, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 写入仍然按「单个会话」处理：一条复用连接可以读多个会话，但写必须指名。
    const sessionId = grant.sessionIds[0];
    if (!sessionId) {
      this.reply(res, 404, { ok: false, message: "no such session" });
      return;
    }
    const body = await readBody(req, MAX_INPUT_BYTES);
    if (body === null) {
      this.reply(res, 413, { ok: false, message: "input too large" });
      return;
    }
    try {
      this.registry.write(sessionId, body);
      this.reply(res, 200, { ok: true });
    } catch (error) {
      this.reply(res, 409, { ok: false, message: messageOf(error) });
    }
  }

  private reply(res: ServerResponse, status: number, payload: unknown): void {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
