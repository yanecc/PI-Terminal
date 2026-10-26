/**
 * 传输层接口：本地 pty 与 SSH shell 的唯一差集就在这里。
 *
 * 会话注册表（sessions.ts）只认这个接口，因此「本地/远程」的分支不会渗进
 * 会话管理、缓冲、回环流与工具里 —— 那些代码对两者完全一致。
 */

export interface TransportEvents {
  /** 原始字节输出。调用方负责放进环形缓冲。 */
  onData: (chunk: Buffer) => void;
  /** 进程/连接结束。code 为退出码，signal 保留给未来的信号语义。 */
  onExit: (code: number | null, signal?: string) => void;
  /** 建立失败或传输层故障（不是正常退出）。 */
  onError: (error: Error) => void;
}

export interface Transport {
  readonly kind: "local" | "ssh";
  /** 写入用户输入。字节而非字符串：粘贴内容可能是任意编码。 */
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** 结束会话。graceMs 给远端一次干净退出的机会。 */
  kill(graceMs?: number): Promise<void>;
  /**
   * 会话就绪后的「真实」工作目录（SSH 需要探测一次 `pwd`）。
   * 本地 pty 直接返回启动目录。
   */
  probeCwd(): Promise<string>;
}

export interface OpenOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * SSH keepalive 间隔（秒）。设置里的全局值由工厂传入；
   * 主机档案自己带 keepaliveSeconds 时以档案为准。
   */
  keepaliveSeconds?: number;
}
