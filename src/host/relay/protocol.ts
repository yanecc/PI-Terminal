/**
 * 回环流的线格式：**NDJSON 一行一个事件**，每行 ASCII JSON，二进制用 base64。
 *
 * 为什么不用 WebSocket：宿主对面板页有 egress 白名单，`ws://` 需要额外的
 * `net.websocket` 权限与另一套连接生命周期；而 `fetch` + 可读流只要 http 就行，
 * 且断点续读（`?from=<seq>`）天然由 URL 参数承载，重连逻辑是「再发一次 GET」。
 *
 * 事件：
 *   {t:"hello", session, seq}      连接建立，告知当前最新序号
 *   {t:"data", seq, data}          一段输出（base64）
 *   {t:"status", status, message?} 会话状态变化
 *   {t:"ping"} / {t:"bye", reason} 保活与关闭
 *
 * 背压：服务端在每个 data 事件之后等客户端把该块**确认消费**（xterm.write 的
 * 回调）才继续读缓冲。实现上不做应用层 ACK —— HTTP 响应流本身有 TCP 背压，
 * 而视图侧在 write 回调里才 `reader.read()` 下一块，因此水位天然受控。
 */

import type { AppSettings, SessionStatus } from "../../protocol.js";

export type RelayEvent =
  | { t: "hello"; session: string; seq: number; status: SessionStatus }
  /* session 在多路复用连接里必有；单会话连接（老客户端）可以为空。 */
  | { t: "data"; session?: string; seq: number; data: string }
  | { t: "status"; session?: string; status: SessionStatus; message?: string }
  | { t: "ping"; at: number }
  | { t: "bye"; session?: string; reason: string }
  /**
   * 全局设置变化（与会话无关）。
   *
   * 宿主不向插件推送设置变更，但**插件自己**可以沿这条已有的回环流把新值推给
   * 面板：否则模型改了字体/字号之后，已经打开的面板要重载才看得见。
   */
  | { t: "settings"; settings: AppSettings };

/** 把事件编码成一行 NDJSON（含结尾换行）。 */
export function encodeEvent(event: RelayEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * 增量解析器：一个 TCP 块里可能有多行，一行也可能被切成几块。
 * 只处理「行」这一层，不猜测内容；坏行交给 onError 由调用方决定是否断开。
 */
export class EventDecoder {
  private pending = "";

  constructor(
    private readonly onEvent: (event: RelayEvent) => void,
    private readonly onError?: (line: string, error: unknown) => void,
  ) {}

  push(chunk: string): void {
    this.pending += chunk;
    let index = this.pending.indexOf("\n");
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      if (line.trim()) {
        try {
          this.onEvent(JSON.parse(line) as RelayEvent);
        } catch (error) {
          this.onError?.(line, error);
        }
      }
      index = this.pending.indexOf("\n");
    }
    // 防御：没有换行的超长行说明对端不是我们的服务，别无限吃内存。
    if (this.pending.length > 8 * 1024 * 1024) {
      this.pending = "";
      this.onError?.("", new Error("relay line too long"));
    }
  }

  get buffered(): string {
    return this.pending;
  }
}
