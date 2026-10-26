/**
 * 会话注册表：本地与 SSH 会话的**唯一**管理者。
 *
 * 视图、回环流、模型工具都通过它访问会话，因此不存在「工具能做的事视图不能做」
 * 这种能力漂移。它同时是以下不变量的守卫：
 *
 *   · 活动会话数上限（默认 8，可配 1–16），超限返回 LIMIT 而不是静默失败；
 *   · seq 单调：每次 flush 之后 seq 只增不减，视图与模型都靠它续读；
 *   · 关闭即释放：transport.kill() + 缓冲清空，且等待 kill 真正落到进程上；
 *   · 状态机单一出口：所有状态变更都走 setStatus，事件只在这里产生。
 */

import { randomUUID } from "node:crypto";

import type {
  OutputChunk,
  SessionKind,
  SessionStatus,
  SessionSummary,
  SshProfile,
} from "../protocol.js";
import { MAX_CHUNK_BYTES } from "../protocol.js";
import { RingBuffer, redactSecrets } from "./ring-buffer.js";
import type { Transport } from "./transport/types.js";

export interface SessionLimits {
  maxSessions: number;
  bufferBytes: number;
  /** 输出合并窗口：把一小段时间内的多次 data 事件合成一块，减少 IPC 与渲染开销。 */
  coalesceMs: number;
}

/**
 * 工厂拿到的会话句柄：建立阶段就能推输出与状态。
 * SSH 握手时的 banner、本地 shell 的初始提示符都属于「会话还没 running
 * 但已经有输出」，所以推送能力必须在建立阶段就可用。
 */
export interface SessionHandle {
  readonly id: string;
  readonly kind: SessionKind;
  status(): SessionStatus;
  push(chunk: Buffer): void;
  setStatus(status: SessionStatus, message?: string): void;
  aborted(): boolean;
  /** 建立完成时补齐元信息（远端 cwd、标题、指纹）。 */
  describe(info: {
    title?: string;
    cwd?: string;
    profileId?: string;
    fingerprint?: string;
    /** `null` 表示「明确清除」；`undefined`/缺省表示「没给」。 */
    hostKeyPending?: { host: string; port: number; fingerprint: string } | null;
  }): void;
  fingerprint(): string | undefined;
}

/** 子进程/连接的建立方式由调用方注入，注册表不关心细节。 */
export type SessionFactory = (input: {
  id: string;
  kind: SessionKind;
  cols: number;
  rows: number;
  profile?: SshProfile;
  /** 仅本地会话：调用方指定的工作目录；缺省由设置决定。 */
  cwd?: string;
  /** 仅本地会话：调用方指定的 shell；缺省用设置里的默认 shell。 */
  shell?: string;
  /** 调用方指定的标签标题；缺省由工厂按目录/主机名生成。 */
  title?: string;
  handle: SessionHandle;
}) => Promise<{ transport: Transport }>;

export type SessionEvent =
  | { type: "data"; sessionId: string; chunk: OutputChunk }
  | { type: "status"; sessionId: string; status: SessionStatus; message?: string };

class SessionEntry {
  readonly id: string;
  readonly kind: SessionKind;
  title: string;
  status: SessionStatus;
  cwd = "";
  profileId?: string;
  cols: number;
  rows: number;
  readonly createdAt: number;
  message?: string;
  hostKeyFingerprint?: string;
  /** 等待用户确认的指纹：由工厂在 onHostKey 时写入，确认后清空。 */
  hostKeyPending?: { host: string; port: number; fingerprint: string };
  transport: Transport | null = null;
  readonly buffer: RingBuffer;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly handle: SessionHandle;

  constructor(
    input: { id: string; kind: SessionKind; title: string; cols: number; rows: number; profileId?: string },
    limits: SessionLimits,
    private readonly emitFn: (entry: SessionEntry, event: SessionEvent) => void,
    private readonly appendFn: (entry: SessionEntry, chunk: Buffer) => void,
    private readonly setStatusFn: (entry: SessionEntry, status: SessionStatus, message?: string) => void,
    private readonly isAborted: (entry: SessionEntry) => boolean,
  ) {
    this.id = input.id;
    this.kind = input.kind;
    this.title = input.title;
    this.status = "starting";
    this.profileId = input.profileId;
    this.cols = input.cols;
    this.rows = input.rows;
    this.createdAt = Date.now();
    this.buffer = new RingBuffer(limits.bufferBytes);

    this.handle = {
      id: this.id,
      kind: this.kind,
      status: () => this.status,
      push: (chunk) => this.appendFn(this, chunk),
      setStatus: (status, message) => this.setStatusFn(this, status, message),
      aborted: () => this.isAborted(this),
      describe: (info) => {
        if (info.title) this.title = info.title;
        if (info.cwd) this.cwd = info.cwd;
        if (info.profileId) this.profileId = info.profileId;
        if (info.fingerprint) this.hostKeyFingerprint = info.fingerprint;
        if (info.hostKeyPending !== undefined) this.hostKeyPending = info.hostKeyPending ?? undefined;
      },
      fingerprint: () => this.hostKeyFingerprint,
    };

    // 定时器不拖住宿主退出。
    Object.defineProperty(this, "flushTimer", { writable: true, value: null });
  }

  /** 传输层输出入口：合并 + 入缓冲 + 广播。 */
  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= MAX_CHUNK_BYTES) {
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 8);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const merged = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    for (let offset = 0; offset < merged.length; offset += MAX_CHUNK_BYTES) {
      const slice = merged.subarray(offset, Math.min(merged.length, offset + MAX_CHUNK_BYTES));
      const seq = this.buffer.push(slice);
      this.emitFn(this, {
        type: "data",
        sessionId: this.id,
        chunk: { seq, data: slice.toString("base64") },
      });
    }
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      status: this.status,
      cwd: this.cwd,
      profileId: this.profileId,
      seq: this.buffer.latestSeq,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      message: this.message,
      hostKeyPending: this.hostKeyPending,
    };
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  /** 面板当前显示的会话（由视图上报；没打开面板时为 null）。 */
  private activeId: string | null = null;

  constructor(
    private readonly factory: SessionFactory,
    private readonly limits: SessionLimits,
  ) {}

  get maxSessions(): number {
    return this.limits.maxSessions;
  }

  /**
   * 记录「面板当前显示哪个会话」。
   *
   * 这本来是纯 UI 状态，但模型需要它 —— `session action="list"` 的
   * `active` 字段让模型知道用户眼前是哪个终端（而不是最近创建或最近有输出的那个）。
   * 传 null 或不存在的 id 都归一成「没有活动会话」。
   */
  setActive(id: string | null): void {
    this.activeId = id && this.sessions.has(id) ? id : null;
  }

  get activeSessionId(): string | null {
    return this.activeId;
  }

  /** 摘要的统一出口：把 UI 侧的 active 合进去，避免某个调用点漏字段。 */
  private summarize(entry: SessionEntry): SessionSummary {
    return { ...entry.summary(), active: entry.id === this.activeId };
  }

  /**
   * 更新限额（宿主设置页改了「最大会话数 / 缓冲大小」之后立刻生效）。
   *
   * 这些值在构造时被复制进注册表，而设置现在可以在运行期被改动：不重设的话，
   * 用户把上限从 8 调到 16 仍然会拿到「最多 8 个」。
   * `bufferBytes` 只影响**之后新建**的会话 —— 已有缓冲按旧尺寸分配，缩不回去，
   * 也不该为了一个数字去丢弃用户正在看的滚动历史。
   */
  configure(limits: Partial<SessionLimits>): void {
    if (typeof limits.maxSessions === "number" && Number.isFinite(limits.maxSessions)) {
      this.limits.maxSessions = Math.max(1, Math.floor(limits.maxSessions));
    }
    if (typeof limits.bufferBytes === "number" && Number.isFinite(limits.bufferBytes)) {
      this.limits.bufferBytes = Math.max(64 * 1024, Math.floor(limits.bufferBytes));
    }
    if (typeof limits.coalesceMs === "number" && Number.isFinite(limits.coalesceMs)) {
      this.limits.coalesceMs = Math.max(0, Math.floor(limits.coalesceMs));
    }
  }

  liveCount(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.status === "running" || entry.status === "starting") count += 1;
    }
    return count;
  }

  /**
   * 可对外列出的会话。
   *
   * **不包含仍在建立中、且还没有任何元信息的条目**（status=starting 且 cwd 为空）。
   * 这类条目是 `open()` 在 factory 返回前短暂放进注册表的半成品：如果它在建立
   * 失败后被清掉，任何在此之前读到它的一方（视图的 1 秒轮询、agent 的
   * `session` 的 action="list"）都会拿着一个永远不会再更新的幽灵会话 ——
   * 表现为标题 "local"、cwd 未知、没有输出，点它什么也不发生。
   *
   * 一旦 factory 补齐了 cwd（哪怕是 SSH 的远端目录），它就会正常出现在列表里；
   * 调用方用 get(id) 仍能读到正在建立中的条目。
   */
  list(): SessionSummary[] {
    return [...this.sessions.values()]
      // 例外：正在等用户确认指纹的会话**必须**可见。确认框就是靠视图轮询这份
      // 摘要才弹出来的，把它藏进「半成品」里会让首次连接永远等不到确认。
      .filter((entry) => entry.hostKeyPending !== undefined || !(entry.status === "starting" && !entry.cwd))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this.summarize(entry));
  }

  /**
   * **全部**会话 id，包括 `list()` 有意隐藏的「建立中」条目。
   *
   * 关闭全部时不能漏掉它们：那些条目同样占着会话名额，也会在建立完成后冒出来。
   */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  get(id: string): SessionSummary | null {
    const entry = this.sessions.get(id);
    return entry ? this.summarize(entry) : null;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  async open(input: {
    kind: SessionKind;
    cols: number;
    rows: number;
    profile?: SshProfile;
    title?: string;
    /** 仅本地会话：调用方指定的工作目录（模型工具用），缺省时由设置决定。 */
    cwd?: string;
    /** 仅本地会话：调用方指定的 shell（命令名或绝对路径），缺省用设置里的默认 shell。 */
    shell?: string;
  }): Promise<SessionSummary> {
    // 只统计「活着」的会话（running / starting）：已结束的会话仍留在列表里
    // 供查看，但它们不该继续占用名额。
    if (this.liveCount() >= this.limits.maxSessions) {
      throw Object.assign(
        new Error(
          `at most ${this.limits.maxSessions} live sessions are allowed. Close one first (the oldest is usually the safest).`,
        ),
        { code: "LIMIT" },
      );
    }

    const entry = new SessionEntry(
      {
        id: randomUUID(),
        kind: input.kind,
        title: input.title ?? (input.kind === "ssh" ? input.profile?.name ?? "ssh" : "local"),
        cols: clampDim(input.cols, 80),
        rows: clampDim(input.rows, 24),
        profileId: input.profile?.id,
      },
      this.limits,
      (target, event) => this.emit(target, event),
      (target, chunk) => target.append(chunk),
      (target, status, message) => this.setStatus(target, status, message),
      (target) => !this.sessions.has(target.id),
    );
    this.sessions.set(entry.id, entry);

    try {
      const opened = await this.factory({
        id: entry.id,
        kind: input.kind,
        cols: entry.cols,
        rows: entry.rows,
        profile: input.profile,
        cwd: input.cwd,
        shell: input.shell,
        title: input.title,
        handle: entry.handle,
      });
      // 建立期间被关掉：立刻回收，别让 transport 泄漏。
      if (!this.sessions.has(entry.id)) {
        await opened.transport.kill().catch(() => undefined);
        throw Object.assign(new Error("session was closed while it was starting"), { code: "NOT_FOUND" });
      }
      entry.transport = opened.transport;
      if (entry.status !== "running") this.setStatus(entry, "running");
      return this.summarize(entry);
    } catch (error) {
      // 建立失败：这个会话**从未真正存在过**（没有 transport、没有 cwd、
      // 没有输出），所以不能把它留在注册表里。
      //
      // 曾经这里只 setStatus("failed") 而保留条目，于是视图轮询会看到一个
      // status=failed、cwd="" 的幽灵会话，画成「标签划线 + unknown cwd +
      // 面板空白」—— 用户看到的就是「新建本地终端坏了」，而真正的错误
      // （例如 pty helper 缺失）只藏在 message 里。
      //
      // 失败必须是**原子**的：清掉条目、释放资源、把错误抛给调用方。
      await this.dispose(entry).catch(() => undefined);
      this.sessions.delete(entry.id);
      this.emit(entry, {
        type: "status",
        sessionId: entry.id,
        status: "failed",
        message: messageOf(error),
      });
      entry.listeners.clear();
      throw error;
    }
  }

  write(id: string, data: Buffer): number {
    const entry = this.getEntry(id);
    if (entry.status !== "running") {
      throw Object.assign(new Error(`session is ${entry.status}; it cannot accept input`), {
        code: "INVALID",
      });
    }
    entry.transport?.write(data);
    return entry.buffer.latestSeq;
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.getEntry(id);
    const nextCols = clampDim(cols, entry.cols);
    const nextRows = clampDim(rows, entry.rows);
    if (nextCols === entry.cols && nextRows === entry.rows) return;
    entry.cols = nextCols;
    entry.rows = nextRows;
    entry.transport?.resize(nextCols, nextRows);
  }

  read(
    id: string,
    fromSeq: number,
    maxBytes = MAX_CHUNK_BYTES,
    maxLines = Number.POSITIVE_INFINITY,
  ): { chunks: OutputChunk[]; nextSeq: number; truncated: boolean } {
    return this.getEntry(id).buffer.read(fromSeq, maxBytes, maxLines);
  }

  /** 模型读取：拼文本 + 脱敏。 */
  readText(
    id: string,
    fromSeq: number,
    maxBytes: number,
    maxLines: number,
  ): { text: string; nextSeq: number; truncated: boolean; redactions: number } {
    const raw = this.getEntry(id).buffer.text(fromSeq, maxBytes, maxLines);
    const { text, redactions } = redactSecrets(raw.text);
    return { ...raw, text, redactions };
  }

  latestSeq(id: string): number {
    return this.getEntry(id).buffer.latestSeq;
  }

  /**
   * 受控地取回底层 transport。
   *
   * 只给「文件传输」这类需要真实通道的操作使用；其余一切写入都必须走 write()，
   * 因为只有那里守着状态机。拿不到时返回 null，调用方必须降级。
   */
  transportFor(id: string): Transport | null {
    return this.sessions.get(id)?.transport ?? null;
  }

  rename(id: string, title: string): SessionSummary {
    const entry = this.getEntry(id);
    const trimmed = title.trim().slice(0, 120);
    if (trimmed) entry.title = trimmed;
    return this.summarize(entry);
  }

  /** 等待输出稳定（静默窗口）或超时：模型工具与「等命令跑完」都靠它。 */
  async waitForIdle(id: string, quietMs: number, timeoutMs: number): Promise<{ quiet: boolean; seq: number }> {
    const entry = this.getEntry(id);
    const started = Date.now();
    let lastSeq = entry.buffer.latestSeq;
    let lastChange = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const seq = entry.buffer.latestSeq;
        if (seq !== lastSeq) {
          lastSeq = seq;
          lastChange = Date.now();
        }
        const quiet = Date.now() - lastChange >= quietMs;
        const timedOut = Date.now() - started >= timeoutMs;
        if (quiet || timedOut) {
          clearInterval(timer);
          resolve({ quiet, seq: lastSeq });
        }
      }, Math.min(50, Math.max(10, quietMs)));
      timer.unref?.();
    });
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    // 关掉的正好是面板上那个：活动会话必须先摘掉，否则列表会指向不存在的 id。
    if (this.activeId === id) this.activeId = null;
    entry.flush();
    await this.dispose(entry);
    this.sessions.delete(id);
    this.emit(entry, { type: "status", sessionId: id, status: "closed" });
    entry.listeners.clear();
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.close(id).catch(() => undefined);
    }
  }

  /** 订阅一个会话的事件（回环流用）。返回退订函数。 */
  subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
    const entry = this.getEntry(id);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /* ── 内部 ───────────────────────────────────────────────────────────── */

  private setStatus(entry: SessionEntry, status: SessionStatus, message?: string): void {
    if (entry.status === status && entry.message === message) return;
    entry.status = status;
    entry.message = message;
    this.emit(entry, { type: "status", sessionId: entry.id, status, message });
  }

  private emit(entry: SessionEntry, event: SessionEvent): void {
    for (const listener of [...entry.listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者自己的错误不能影响其他订阅者（例如视图已卸载）。
      }
    }
  }

  private getEntry(id: string): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) {
      throw Object.assign(new Error(`no such session: ${id}`), { code: "NOT_FOUND" });
    }
    return entry;
  }

  /** 释放：先 flush 尾巴，再结束传输。缓冲由调用方决定是否清空。 */
  private async dispose(entry: SessionEntry): Promise<void> {
    entry.flush();
    const transport = entry.transport;
    entry.transport = null;
    if (transport) await transport.kill().catch(() => undefined);
  }
}

function clampDim(value: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(4096, Math.max(1, n));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
