/**
 * 回环流的**多路复用**连接。
 *
 * ── 为什么必须复用一个连接 ────────────────────────────────────────────────
 * 每个会话各开一条 `fetch` 长连接时，第 7 个终端永远是空白：Chromium 对
 * 「同一 host:port 的并发连接」上限是 **6**（HTTP/1.1 的老约定），第 7 个请求
 * 根本发不出去，视图一直停在 connecting、seq 0。实测 7 个标签时前 6 个正常、
 * 第 7 个空白，正是这个上限。
 *
 * 所以这里把所有会话合并到**一条** NDJSON 流上：请求带
 * `?sessions=<id>:<from>,<id>:<from>`，服务端为每个会话补历史并订阅，事件里带
 * `session` 字段，由这里分发回各自的消费者。
 *
 * 成员变化（新开/关闭标签）就重连一次：服务端按 `id:from` 补历史，重连不会
 * 重复写屏（seq 单调，客户端也会丢弃旧块）。
 */

import { api, fromBase64 } from "./bridge.js";
import type { RelayInfo } from "../protocol.js";

export type MuxStatus = "live" | "connecting" | "polling" | "closed" | "error";

export interface MuxSubscriber {
  /** 已经渲染到的 seq（重连时从它 +1 开始补）。 */
  fromSeq: () => number;
  /** 收到一段输出；必须在渲染完成后调用 done()（背压）。 */
  onData: (bytes: Uint8Array, seq: number, done: () => void) => void;
  onStatus: (status: MuxStatus, detail?: string) => void;
  /** 连接彻底不可用（端口被关、被策略拦）：订阅方应自行降级到轮询。 */
  onFatal: (reason: string) => void;
}

interface MuxEvent {
  t: string;
  session?: string;
  seq?: number;
  data?: string;
  status?: string;
  message?: string;
  reason?: string;
  /** t === "settings" 时的全局设置。 */
  settings?: unknown;
}

/** 连续失败这么多次就判死刑（交给轮询），避免一直挂着重连。 */
const MAX_ATTEMPTS = 4;

class RelayMux {
  private readonly subs = new Map<string, MuxSubscriber>();
  /** 全局设置变化的监听（与会话无关）：模型改设置时靠它即时生效。 */
  private settingsListener: ((settings: unknown) => void) | null = null;
  private controller: AbortController | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private retryTimer: number | null = null;
  private attempts = 0;
  private pending = false;

  /** 注册设置变化监听（传 null 取消）。 */
  setSettingsListener(listener: ((settings: unknown) => void) | null): void {
    this.settingsListener = listener;
  }

  subscribe(sessionId: string, subscriber: MuxSubscriber): Promise<void> {
    this.subs.set(sessionId, subscriber);
    return this.restart();
  }

  unsubscribe(sessionId: string): void {
    if (!this.subs.delete(sessionId)) return;
    if (this.subs.size > 0) void this.restart();
    else this.shutdown();
  }

  /**
   * 断开并按当前成员重建连接。
   *
   * 关键：重建期间可能又有新会话订阅（连着开几个标签）。此时不能直接 return —
   * 一次丢掉的「重连请求」会让整条连接停在废弃状态，表现为部分标签永远空白。
   * 所以用 pending 标记：当前这轮跑完后如果还有未处理的变化，就再跑一轮。
   */
  private async restart(): Promise<void> {
    this.shutdown();
    await this.connect();
  }

  private shutdown(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
    this.connected = false;
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    if (this.subs.size === 0) return;
    if (this.connecting) {
      // 正在连：记下来，等这一轮结束后按最新的成员再连一次。
      this.pending = true;
      return;
    }
    this.connecting = (async () => {
      do {
        this.pending = false;
        await this.runOnce();
      } while (this.pending && this.subs.size > 0);
    })().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  private async runOnce(): Promise<void> {
    let info: RelayInfo;
    try {
      info = await api.relayMux();
    } catch (error) {
      this.fail(messageOf(error));
      return;
    }

    const url = new URL(info.url);
    url.searchParams.set(
      "sessions",
      [...this.subs.entries()].map(([id, sub]) => `${id}:${sub.fromSeq() + 1}`).join(","),
    );

    const controller = new AbortController();
    this.controller = controller;

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${info.token}` },
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (!controller.signal.aborted) this.fail(messageOf(error));
      return;
    }
    if (!response.ok || !response.body) {
      this.fail(`the loopback stream answered ${response.status}`);
      return;
    }

    this.connected = true;
    this.attempts = 0;
    for (const sub of this.subs.values()) sub.onStatus("live");

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) await this.handle(line);
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      // abort（成员变化）或网络抖动：交给下面的重连判断。
    }

    this.connected = false;
    // 主动 abort 说明有人调用了 restart/shutdown，不重连。
    if (!controller.signal.aborted && this.subs.size > 0) this.scheduleRetry("the stream ended");
  }

  private async handle(line: string): Promise<void> {
    let event: MuxEvent;
    try {
      event = JSON.parse(line) as MuxEvent;
    } catch {
      return;
    }
    // 全局事件与会话无关，先处理，避免因为「没有对应订阅」被丢掉。
    if (event.t === "settings") {
      this.settingsListener?.(event.settings);
      return;
    }

    const id = event.session;
    const sub = id ? this.subs.get(id) : undefined;
    if (!sub) return;

    if (event.t === "data" && typeof event.data === "string") {
      const seq = typeof event.seq === "number" ? event.seq : sub.fromSeq() + 1;
      if (seq <= sub.fromSeq()) return;
      const bytes = fromBase64(event.data);
      await new Promise<void>((resolve) => sub.onData(bytes, seq, resolve));
      return;
    }
    if (event.t === "status") {
      sub.onStatus(event.status === "closed" ? "closed" : event.status === "failed" ? "error" : "live", event.message);
      return;
    }
    if (event.t === "bye") {
      sub.onStatus(event.reason === "closed" ? "closed" : "error", event.reason);
    }
  }

  private scheduleRetry(reason: string): void {
    this.shutdown();
    this.attempts += 1;
    if (this.attempts >= MAX_ATTEMPTS) {
      this.fail(reason);
      return;
    }
    const delay = Math.min(4000, 250 * 2 ** this.attempts);
    for (const sub of this.subs.values()) sub.onStatus("connecting", reason);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  /** 彻底失败：通知每个订阅方自行降级（轮询），并清空成员。 */
  private fail(reason: string): void {
    this.connected = false;
    const subs = [...this.subs.values()];
    this.subs.clear();
    this.shutdown();
    this.attempts = 0;
    for (const sub of subs) sub.onFatal(reason);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 视图内唯一的复用连接：所有会话共享它。 */
export const relayMux = new RelayMux();
