/**
 * 本文件提供通过 Rust 安全边界执行的通用 HTTP fetch。
 * 支持有界响应、流式读取和原生取消，启动确认保证提前取消不会遗留长轮询。
 */

import { getNativeHost } from "@/lib/nativeHost";

type HttpEvent =
  | { kind: "started" }
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; bytes: number[] }
  | { kind: "end" };

export type NetworkTarget =
  | { kind: "direct" | "markdown" }
  | { kind: "provider" | "channel" | "speech"; id: string };

export type HttpOptions = {
  allowPrivateNetwork?: boolean;
  networkTarget?: NetworkTarget;
  timeoutMs?: number | null;
  maxResponseBytes?: number;
};

/** 创建固定网络策略的 fetch；总超时为 null 时由调用者负责取消。 */
export function createHttpFetch(options: HttpOptions = {}): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = request.signal;
    signal.throwIfAborted();
    const body = request.body
      ? Array.from(new Uint8Array(await request.arrayBuffer()))
      : undefined;
    signal.throwIfAborted();
    const host = await getNativeHost();
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    return new Promise<Response>((resolve, reject) => {
      let started = false;
      let cancelled = false;
      let finished = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const fail = (error: unknown) => {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        reject(failure);
        try {
          controller?.error(failure);
        } catch {
          // 消费者可能已关闭正文流。
        }
      };
      const cancelNative = () => {
        void host.invoke("http_cancel", { requestId }).catch(() => undefined);
      };
      const abort = () => {
        if (finished || cancelled) return;
        cancelled = true;
        fail(new DOMException("Request aborted", "AbortError"));
        if (started) cancelNative();
      };
      signal.addEventListener("abort", abort, { once: true });
      const onEvent = host.channel<HttpEvent>();
      onEvent.onmessage = (event) => {
        if (event.kind === "started") {
          started = true;
          if (cancelled) cancelNative();
          return;
        }
        if (cancelled || finished) return;
        if (event.kind === "headers") {
          const empty =
            request.method === "HEAD" || [204, 205, 304].includes(event.status);
          const stream = empty
            ? null
            : new ReadableStream<Uint8Array>({
                start(value) {
                  controller = value;
                },
                cancel: abort,
              });
          try {
            resolve(
              new Response(stream, {
                status: event.status,
                headers: event.headers,
              }),
            );
          } catch (error) {
            fail(error);
            abort();
          }
        } else if (event.kind === "chunk") {
          controller?.enqueue(Uint8Array.from(event.bytes));
        } else {
          finished = true;
          controller?.close();
          signal.removeEventListener("abort", abort);
        }
      };
      // 注册监听与 IPC 发起之间发生的取消，仍在收到原生确认后回收请求。
      if (signal.aborted) abort();
      void host
        .invoke("http_request", {
          requestId,
          url: request.url,
          method: request.method,
          redirect: request.redirect,
          headers: Object.fromEntries(request.headers),
          body,
          allowPrivateNetwork: options.allowPrivateNetwork === true,
          networkTarget: options.networkTarget ?? { kind: "direct" },
          timeoutMs:
            options.timeoutMs === undefined ? 15_000 : options.timeoutMs,
          maxResponseBytes: options.maxResponseBytes ?? 2 * 1024 * 1024,
          onEvent,
        })
        .catch((error) => {
          if (!cancelled) fail(error);
          finished = true;
          signal.removeEventListener("abort", abort);
        })
        .finally(() => {
          if (cancelled || finished) signal.removeEventListener("abort", abort);
        });
    });
  };
}
