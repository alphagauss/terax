/**
 * 本文件通过私有子进程管道接入共享 Rust 原生服务。
 * 协议响应按请求分发，退出时关闭输入等待原生清理，不监听端口或接收外部连接。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeChannel, NativeHost } from "@/lib/nativeHost";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  channel?: NativeChannel<unknown>;
};

type PackagedNativeHost = { executable: string; embedded: boolean };

let packagedNativeHost: PackagedNativeHost | undefined;

/**
 * 注册发行构建的原生宿主；embedded 表示路径位于 Bun 虚拟文件系统，执行前需要释放。
 *
 * 开发入口不调用此函数，仍从工作树的 debug 输出启动宿主。外部
 * `TERAX_NATIVE_HOST` 始终具有更高优先级，以保留诊断和测试能力。
 */
export function setPackagedNativeHost(host: PackagedNativeHost) {
  packagedNativeHost = host;
}

/**
 * 解析本次运行所需的原生宿主，并在内嵌模式下释放到独占临时目录。
 *
 * Rust 宿主必须由操作系统作为子进程加载，不能直接从 Bun 的虚拟文件系统执行。
 * 使用每次运行独有的目录可避免固定路径被其他进程替换；调用方负责在子进程结束后清理。
 */
function resolveNativeHost() {
  const configured = process.env.TERAX_NATIVE_HOST;
  if (configured) return { executable: configured };
  if (!packagedNativeHost) {
    return {
      executable: fileURLToPath(
        new URL(
          `../target/debug/terax-host${process.platform === "win32" ? ".exe" : ""}`,
          import.meta.url,
        ),
      ),
    };
  }
  if (!packagedNativeHost.embedded)
    return { executable: packagedNativeHost.executable };
  const directory = mkdtempSync(join(tmpdir(), "terax-host-"));
  const executable = join(
    directory,
    `terax-host${process.platform === "win32" ? ".exe" : ""}`,
  );
  try {
    const contents = readFileSync(packagedNativeHost.executable);
    writeFileSync(executable, contents, { flag: "wx" });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    executable,
    cleanup: () =>
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
  };
}

/** 启动当前平台的原生宿主，并为所有请求保留唯一的关联身份。 */
export function createTerminalHost(cwd: string) {
  const { executable, cleanup } = resolveNativeHost();
  const child = spawn(executable, [cwd], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map<number, Pending>();
  let sequence = 0;
  let buffer = "";
  let closed = false;
  let failure: Error | undefined;
  const rejectAll = (error: Error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", rejectAll);
  child.stdin.on("error", rejectAll);
  // 原生启动诊断不混入协议，限制保留长度，且不记录请求或凭据。
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("close", (code) => {
      closed = true;
      rejectAll(
        new Error(
          diagnostics.trim() || `Native host exited (${code ?? "signal"})`,
        ),
      );
      // 杀毒软件可能暂时占用已退出的程序；临时文件回收失败不能打断业务收尾。
      try {
        cleanup?.();
      } catch {}
      resolve();
    }),
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) {
      rejectAll(new Error("Native host response exceeds the protocol limit"));
      child.stdin.end();
      return;
    }
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line) as {
          id: number;
          event?: unknown;
          result?: unknown;
          error?: string;
        };
        const request = pending.get(response.id);
        if (!request) continue;
        if ("event" in response) request.channel?.onmessage(response.event);
        else {
          pending.delete(response.id);
          if (response.error) request.reject(new Error(response.error));
          else request.resolve(response.result);
        }
      } catch {
        rejectAll(new Error("Invalid native host response"));
        child.stdin.end();
      }
    }
  });
  const host: NativeHost = {
    workspace: () => ({ kind: "local" }),
    channel: <T>() => ({ onmessage: (_event: T) => {} }),
    invoke: <T>(command: string, args: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        if (closed || failure) {
          reject(failure ?? new Error("Native host is closed"));
          return;
        }
        if (pending.size >= 64) {
          reject(new Error("Too many native requests"));
          return;
        }
        const id = ++sequence;
        const { onEvent, ...params } = args;
        const line = `${JSON.stringify({ id, command, args: params })}\n`;
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) {
          reject(new Error("Native request exceeds the protocol limit"));
          return;
        }
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          channel: onEvent as NativeChannel<unknown> | undefined,
        });
        child.stdin.write(line, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      }),
  };
  return {
    host,
    /** 关闭输入并等待原生资源清理，不直接强杀受管宿主。 */
    async close() {
      if (!closed) child.stdin.end();
      await exited;
    },
  };
}
