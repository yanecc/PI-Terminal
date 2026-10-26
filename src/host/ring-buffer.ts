/**
 * 每会话的输出环形缓冲。
 *
 * 为什么按「块」而不是按字节存：视图按 seq 续读、模型按 seq 取增量，
 * 两者都需要「一次读取是一个完整块」的语义。把一个多字节字符切成两半的
 * 缓冲会让 xterm 渲染出半个字符，也会让模型的文本读取出现乱码。
 *
 * 裁剪策略：总量超过上限时从最旧的块开始丢弃，但**至少保留一块**，
 * 这样「刚写了 1MB 然后立刻读」不会读到空。丢弃时把 droppedBeforeSeq 抬到
 * 被丢块的起始 seq，读者据此知道「你要的位置已经不在了」。
 */

import type { OutputChunk } from "../protocol.js";

interface Entry {
  /** 该块第一段的序号（含）。 */
  startSeq: number;
  /** 该块最后一段的序号（含）。 */
  endSeq: number;
  bytes: Buffer;
}

export class RingBuffer {
  private entries: Entry[] = [];
  private bytes = 0;
  private nextSeq = 1;
  /** 已被裁剪掉的最早可用序号：小于它的读取请求会被告知截断。 */
  private droppedBeforeSeq = 1;

  constructor(private readonly limitBytes: number) {
    if (!Number.isFinite(limitBytes) || limitBytes < 4096) {
      throw new Error("RingBuffer limit must be >= 4096 bytes");
    }
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get earliestSeq(): number {
    return this.droppedBeforeSeq;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  /**
   * 追加一段输出。
   *
   * 同一毫秒内 pty 的多次 data 事件会合成一块（`coalesceWindowMs` 之外的调用方
   * 直接等价于「每段一块」）：本实现不做时间合并，合并由调用方按帧边界决定，
   * 因为只有调用方知道哪些字节应该一起显示。
   */
  push(data: Buffer): number {
    if (data.length === 0) return this.latestSeq;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.entries.push({ startSeq: seq, endSeq: seq, bytes: Buffer.from(data) });
    this.bytes += data.length;
    this.trim();
    return seq;
  }

  private trim(): void {
    while (this.bytes > this.limitBytes && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.bytes -= dropped.bytes.length;
      this.droppedBeforeSeq = dropped.endSeq + 1;
    }
  }

  /**
   * 读取 `fromSeq` 之后（含）的输出，最多 `maxBytes` / `maxLines`。
   *
   * `truncated=true` 表示请求的起点早于仍保留的最旧序号，调用方要把这个事实
   * 显式告诉用户或模型，而不是假装读全了。
   */
  read(fromSeq: number, maxBytes: number, maxLines = Number.POSITIVE_INFINITY): {
    chunks: OutputChunk[];
    nextSeq: number;
    truncated: boolean;
  } {
    const from = Math.max(1, Math.floor(Number(fromSeq) || 1));
    const truncated = from < this.droppedBeforeSeq;
    const start = Math.max(from, this.droppedBeforeSeq);
    const chunks: OutputChunk[] = [];
    let used = 0;
    let lines = 0;
    let nextSeq = start;

    for (const entry of this.entries) {
      if (entry.endSeq < start) continue;
      if (used + entry.bytes.length > maxBytes && chunks.length > 0) break;
      // 单块本身就超过预算时仍然返回它：截断字节会切坏字符。
      const lineCount = countNewlines(entry.bytes);
      if (lines + lineCount > maxLines && chunks.length > 0) break;
      chunks.push({ seq: entry.endSeq, data: entry.bytes.toString("base64") });
      used += entry.bytes.length;
      lines += lineCount;
      nextSeq = entry.endSeq + 1;
    }

    if (chunks.length === 0) nextSeq = Math.max(start, this.nextSeq);
    return { chunks, nextSeq, truncated };
  }

  /** 把保留范围内的输出拼成文本（模型读取与「复制全部」共用）。 */
  text(fromSeq: number, maxBytes: number, maxLines: number): {
    text: string;
    nextSeq: number;
    truncated: boolean;
  } {
    const read = this.read(fromSeq, maxBytes, maxLines);
    const raw = Buffer.concat(read.chunks.map((chunk) => Buffer.from(chunk.data, "base64")));
    return { text: raw.toString("utf8"), nextSeq: read.nextSeq, truncated: read.truncated };
  }

  clear(): void {
    this.entries = [];
    this.bytes = 0;
    this.droppedBeforeSeq = this.nextSeq;
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) count += 1;
  }
  return count;
}

/**
 * 输出脱敏：模型读取路径必须过滤掉「看起来是秘密」的行。
 *
 * 刻意做得**保守**（宁可多遮）：漏遮一个密钥的代价远大于多遮一行日志。
 * 只在读取给模型时应用；用户自己看终端时永远是原始字节。
 */
const SECRET_PATTERNS: RegExp[] = [
  /(?:^|\s)(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY)\s*[=:]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}/g,
  // 厂商前缀的令牌（GitHub / GitLab / Slack / npm / OpenAI / AWS）。
  // 这类东西经常**不带** `KEY=` 前缀就出现在日志里（`git clone` 的 URL、
  // `curl -H` 的回显），所以必须按形态而不是键名识别。
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

export const REDACTED = "«redacted»";

export function redactSecrets(text: string): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      redactions += 1;
      // 保留 `KEY=` 这样的前缀，读的人才知道被遮的是什么。
      const prefix = /^[^=:]{1,64}[=:]\s*/.exec(match);
      return prefix ? `${prefix[0]}${REDACTED}` : REDACTED;
    });
  }
  return { text: out, redactions };
}
