/**
 * 回环流消费者（单会话视角）。
 *
 * 真正的连接由 `relay-mux.ts` 维护：**所有会话共用一条** HTTP 长连接，否则第 7
 * 个终端会撞上浏览器「同一 host:port 最多 6 条连接」的上限而永远空白。这里只负责
 * 一个会话的那一半语义：
 *   1. **背压**：xterm 的 `write(data, cb)` 回调表示这一块已经进了渲染队列，
 *      只有回调之后才算消费完毕；
 *   2. **断点续读**：把已经渲染到的 seq 交给复用层，重连时只补没渲染过的块；
 *   3. **降级**：回环端口不可用（被策略拦、被占用、用户关掉）时自动改用
 *      `term.read` 控制面轮询 —— 功能不减，只是延迟变差，并在状态栏如实标注。
 */

import { api, fromBase64 } from "./bridge.js";
import { relayMux } from "./relay-mux.js";

export type StreamStatus = "connecting" | "live" | "polling" | "closed" | "error";

export interface StreamHandlers {
  /** 一段输出。实现方必须在渲染完成后调用 done()，这是背压的唯一信号。 */
  onData: (bytes: Uint8Array, seq: number, done: () => void) => void;
  onStatus: (status: StreamStatus, detail?: string) => void;
}

export class SessionStream {
  private seq = 0;
  private closed = false;
  private pollTimer: number | null = null;
  private reconnectDelay = 500;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: StreamHandlers,
    private readonly initialSeq = 0,
  ) {
    this.seq = initialSeq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * 开始接收输出。
   *
   * `relayAvailable` 只表示「设置里允许用回环流」；端口真的不通时复用层会
   * 回调 onFatal，这里再降级到轮询。
   */
  async start(relayAvailable: boolean): Promise<void> {
    if (this.closed) return;
    if (!relayAvailable) {
      this.startPolling("the loopback relay is disabled");
      return;
    }
    this.handlers.onStatus("connecting");
    await relayMux.subscribe(this.sessionId, {
      fromSeq: () => this.seq,
      onData: (bytes, seq, done) => this.deliver(bytes, seq, done),
      onStatus: (status, detail) => {
        if (!this.closed) this.handlers.onStatus(status, detail);
      },
      onFatal: (reason) => {
        if (!this.closed) this.startPolling(reason);
      },
    });
  }

  stop(): void {
    this.closed = true;
    relayMux.unsubscribe(this.sessionId);
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** 渲染一块输出并推进 seq；重复投递（重连边界）直接丢弃。 */
  private async deliver(bytes: Uint8Array, seq: number, done: () => void): Promise<void> {
    if (seq <= this.seq) {
      done();
      return;
    }
    await new Promise<void>((resolve) => this.handlers.onData(bytes, seq, resolve));
    this.seq = seq;
    done();
  }

  /* ── 降级轮询 ───────────────────────────────────────────────────────── */

  private startPolling(reason: string): void {
    if (this.closed) return;
    relayMux.unsubscribe(this.sessionId);
    this.handlers.onStatus("polling", reason);
    const tick = async (): Promise<void> => {
      if (this.closed) return;
      try {
        const result = await api.read(this.sessionId, this.seq + 1, 256 * 1024);
        for (const chunk of result.chunks) {
          if (chunk.seq <= this.seq) continue;
          const bytes = fromBase64(chunk.data);
          await this.deliver(bytes, chunk.seq, () => undefined);
        }
        this.reconnectDelay = 500;
      } catch (error) {
        // 会话已被关闭时 read 会返回 NOT_FOUND：停下来，不再空转。
        const message = error instanceof Error ? error.message : String(error);
        if (/no such session/i.test(message)) {
          this.handlers.onStatus("closed");
          return;
        }
        this.reconnectDelay = Math.min(4000, this.reconnectDelay * 2);
      }
      this.pollTimer = window.setTimeout(() => void tick(), this.reconnectDelay > 1000 ? this.reconnectDelay : 120);
    };
    this.pollTimer = window.setTimeout(() => void tick(), 0);
  }
}
