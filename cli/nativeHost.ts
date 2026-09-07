/**
 * 本文件通过私有子进程管道接入共享 Rust 原生服务。
 * 协议响应按请求分发，退出时关闭输入等待原生清理，不监听端口或接收外部连接。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { NativeChannel, NativeHost } from "@/lib/nativeHost";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  channel?: NativeChannel<unknown>;
};

/** 启动当前平台的原生宿主，并为所有请求保留唯一的关联身份。 */
export function createTerminalHost(cwd: string) {
  const executable =
    process.env.TERAX_NATIVE_HOST ??
    fileURLToPath(
      new URL(
        `../src-tauri/target/debug/terax-host${process.platform === "win32" ? ".exe" : ""}`,
        import.meta.url,
      ),
    );
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
