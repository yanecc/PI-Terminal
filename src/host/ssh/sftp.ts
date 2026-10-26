/**
 * SFTP 传输层：文件/目录的上传与下载，**统一走 ssh2-sftp-client**。
 *
 * ── 为什么不自己拼 SFTPStream ─────────────────────────────────────────────
 * ssh2 只提供 `SFTPWrapper`（OPEN/WRITE/READ/CLOSE 这些原语）。要支持目录上传、
 * 目录下载、递归创建、并行分块，就得自己写一整套目录遍历与错误翻译 —— 那正是
 * ssh2-sftp-client 已经写好、并且被大量生产环境用过的部分。所以这里的分工是：
 *   · ssh2（我们自己的 Client）负责连接、认证、主机指纹；
 *   · ssh2-sftp-client 负责一切文件语义。
 *
 * ── 复用已有连接，而不是再握手一次 ───────────────────────────────────────
 * 传输必须发生在**用户已经信任的那条连接**上。若另起一条连接（哪怕用同一份
 * 凭据），就会再走一遍主机指纹与认证：要么弹两次确认，要么把已经校验过的
 * 事实当成理所当然。SftpClient 内部把连接放在 `client` 字段，这里直接把已认证的
 * ssh2 Client 换进去，然后自己开 SFTP 子系统通道。
 *
 * 两条铁律：
 *   1. 绝不调用 `SftpClient.end()` —— 它会 `client.end()`，而那条连接属于用户的
 *      终端会话，结束它就等于把用户正在用的终端踢掉；
 *   2. 用完只 `handle.end()`，关掉这次传输自己的子系统通道即可。
 *
 * ── 两种传输方式（工具参数 `stream`）──────────────────────────────────────
 *   stream=false（默认）并行分块：文件 `fastPut` / `fastGet`，目录
 *                `uploadDir(useFastput:true)` / `downloadDir(useFastget:true)`。
 *                大文件吞吐最好，但依赖服务端支持的扩展请求。
 *   stream=true  单流搬运：文件 `put(readable)` / `get(remotePath, writable)`，
 *                目录 `uploadDir(useFastput:false)` / `downloadDir(useFastget:false)`。
 *                任何服务端都能用，内存与请求都更保守。
 *   内联文本（没有本地文件）永远是 `put(buffer, remotePath)`。
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Client, SFTPWrapper } from "ssh2";
import SftpClient from "ssh2-sftp-client";

/** SftpClient 内部字段（@types 没有声明，这里显式地只借用这两个）。 */
interface SftpInternals {
  client: Client;
  sftp?: SFTPWrapper;
}

export type TransferKind = "text" | "file" | "directory";

export interface UploadRequest {
  /** 远端绝对路径。文件=目标文件；目录=目标目录（内容拷进这里）。 */
  remotePath: string;
  /** 内联内容（文本或二进制）。与 localPath 二选一。 */
  content?: Buffer;
  /** 本机文件或目录。 */
  localPath?: string;
  /** 新建文件时的权限位。 */
  mode?: number;
  stream: boolean;
}

export interface DownloadRequest {
  /** 远端绝对路径。 */
  remotePath: string;
  /** 本机目标路径；省略时把文件内容内联回传给调用方。 */
  localPath?: string;
  stream: boolean;
  /** 内联上限（字节）。只在没有 localPath 时生效。 */
  maxBytes?: number;
}

export interface TransferOutcome {
  kind: TransferKind;
  /** 实际用到的 ssh2-sftp-client 调用，便于审计与排查。 */
  transport: string;
  bytes?: number;
  /** 目录传输时本地侧的文件数。 */
  entries?: number;
  /** 内联回传的文件内容。 */
  content?: Buffer;
}

/**
 * 在一条已认证的 ssh2 连接上开一个 SFTP 会话，用完自动关掉通道。
 *
 * 连接本身（以及它承载的终端）保持不动：这里只借用它的 sftp 子系统。
 *
 * ── 顺序很重要：先构造，后替换 client ────────────────────────────────────
 * `SftpClient` 的构造函数会往**它自己 new 出来的那个 Client** 上挂
 * `close` / `end` / `error` 三个监听器，且从不移除。如果我们先把
 * `instance.client = client` 赋好再触发构造（或反过来复用同一个实例），
 * 那些监听器就会落到用户**共享的连接**上 —— 每传一次文件就多三只，直到
 * Node 报 MaxListenersExceeded，而且这只“临时 Client”上的监听器会在
 * close 时把 reject 传播到一个没人 await 的 Promise 上。
 *
 * 因此这里每次传输都 new 一个实例、并**在构造之后**才替换 client：构造时
 * 挂的三个监听器落在那个随即被丢弃的 Client 上，共享连接干干净净。
 * 已实测：12 次连续传输后共享连接上的 close/end/error 监听器数量不变
 * （0 / 0 / 2，后两个是 ssh2 自己的）。
 *
 * 同理**绝不调用 `instance.end()`**：它会走 `this.client.end()`，把用户正在
 * 用的终端连接一起断掉。这里只 `handle.end()` 关掉本次的子系统通道。
 */
export async function withSftp<T>(
  client: Client,
  run: (sftp: SftpClient) => Promise<T>,
): Promise<T> {
  const instance = new SftpClient("pi-terminal", {
    // 静默：默认回调会往 stdout 打日志，插件进程里那是噪音。
    error: () => undefined,
    end: () => undefined,
    close: () => undefined,
  }) as SftpClient & SftpInternals;

  // 关键一步：把已认证的连接交给 SftpClient（见文件头「复用已有连接」）。
  instance.client = client;
  const handle = await openChannel(client);
  instance.sftp = handle;
  try {
    return await run(instance);
  } finally {
    instance.sftp = undefined;
    try {
      handle.end();
    } catch {
      /* 已经随连接一起关了 */
    }
  }
}

function openChannel(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, handle) => {
      if (error) reject(new Error(`cannot open an SFTP channel: ${error.message}`));
      else resolve(handle);
    });
  });
}

/* ── 上传 ─────────────────────────────────────────────────────────────── */

/**
 * 上传：内联文本 → 文件 → 目录，按给定参数自动选路。
 *
 * `localPath` 是目录时走 `uploadDir`，语义是「把 localPath 里的**内容**放进
 * remotePath」，而不是在 remotePath 下再建一层同名目录。
 */
export async function uploadVia(sftp: SftpClient, request: UploadRequest): Promise<TransferOutcome> {
  const mode = request.mode ?? 0o644;

  if (request.content) {
    // 内联内容没有本地文件：put 接受 Buffer，内部就是一条写流。
    await sftp.put(request.content, request.remotePath, { writeStreamOptions: { mode } });
    return { kind: "text", transport: "sftp.put(buffer)", bytes: request.content.length };
  }

  const localPath = request.localPath;
  if (!localPath) throw new Error("upload needs either content or localPath");
  const info = await stat(localPath).catch(() => null);
  if (!info) throw new Error(`localPath does not exist: ${localPath}`);

  if (info.isDirectory()) {
    const entries = await countFiles(localPath);
    await sftp.uploadDir(localPath, request.remotePath, { useFastput: !request.stream });
    return {
      kind: "directory",
      transport: request.stream ? "sftp.uploadDir(useFastput:false)" : "sftp.uploadDir(useFastput:true)",
      entries,
    };
  }

  if (request.stream) {
    await sftp.put(createReadStream(localPath), request.remotePath, { writeStreamOptions: { mode } });
    return { kind: "file", transport: "sftp.put(readable)", bytes: info.size };
  }

  await sftp.fastPut(localPath, request.remotePath, { mode });
  return { kind: "file", transport: "sftp.fastPut", bytes: info.size };
}

/* ── 下载 ─────────────────────────────────────────────────────────────── */

/**
 * 下载：目录必须给 localPath；文件给了 localPath 就落盘，没给就内联回传。
 *
 * 内联有一条硬上限：把几十兆的内容塞进工具结果既不是「读取」也不是「传输」，
 * 那是把模型的上下文当垃圾桶。超限时明确要求改用 localPath。
 */
export async function downloadVia(sftp: SftpClient, request: DownloadRequest): Promise<TransferOutcome> {
  const info = await sftp.stat(request.remotePath).catch(() => null);
  if (!info) throw new Error(`remote path does not exist: ${request.remotePath}`);

  if (info.isDirectory) {
    const localPath = request.localPath;
    if (!localPath) {
      throw new Error(
        "downloading a directory needs localPath (the local folder to copy into); a folder is never returned inline",
      );
    }
    await mkdir(localPath, { recursive: true });
    await sftp.downloadDir(request.remotePath, localPath, { useFastget: !request.stream });
    return {
      kind: "directory",
      transport: request.stream ? "sftp.downloadDir(useFastget:false)" : "sftp.downloadDir(useFastget:true)",
    };
  }

  const localPath = request.localPath;
  if (!localPath) {
    const maxBytes = request.maxBytes ?? 256 * 1024;
    if (info.size > maxBytes) {
      throw new Error(
        `remote file is ${info.size} bytes, above the ${maxBytes}-byte inline limit. Pass localPath to save it locally ` +
          "(add stream=true for a streamed transfer).",
      );
    }
    const data = await sftp.get(request.remotePath);
    if (!Buffer.isBuffer(data)) throw new Error("sftp.get did not return the file content");
    return { kind: "file", transport: "sftp.get(remotePath)", bytes: data.length, content: data };
  }

  // 目标目录不存在时 fastGet/get 会直接 ENOENT：先建好，错误才有意义。
  await mkdir(dirname(localPath), { recursive: true });
  if (request.stream) {
    await sftp.get(request.remotePath, createWriteStream(localPath));
    return { kind: "file", transport: "sftp.get(remotePath, writable)", bytes: info.size };
  }
  await sftp.fastGet(request.remotePath, localPath);
  return { kind: "file", transport: "sftp.fastGet", bytes: info.size };
}

/* ── 辅助 ─────────────────────────────────────────────────────────────── */

async function countFiles(dir: string): Promise<number> {
  let total = 0;
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.isDirectory()) total += await countFiles(join(dir, item.name));
    else total += 1;
  }
  return total;
}
