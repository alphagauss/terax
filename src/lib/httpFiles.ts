/** 通用原生 HTTP 文件能力；业务编排请求，字节快照、变换与文件发布留在宿主。 */
import { getNativeHost } from "@/lib/nativeHost";
import type { NetworkTarget } from "@/lib/http";

export type HttpFileContext = {
  root: string;
  ownerSessionId: string;
  permissionMode: "ask" | "full-access";
};
export type FileTransform = {
  algorithm: "aes-128-ecb-pkcs7";
  operation: "encrypt" | "decrypt";
  key: number[];
};
export type PreparedHttpFile = {
  id: string;
  name: string;
  size: number;
  bodySize: number;
  md5: string;
};
export type HttpFileResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
  file?: { path: string; size: number };
};
export type HttpFileRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  networkTarget: NetworkTarget;
  allowPrivateNetwork?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  bodyFile?: string;
  destination?: {
    root: string;
    path: string;
    renameOnConflict?: boolean;
    maxBytes: number;
    transform?: FileTransform;
  };
};

/** 启动确认解决取消先于原生登记的竞争，调用结束前始终等待原生资源退出。 */
async function fileOperation<T>(
  command: string,
  request: object,
  signal: AbortSignal,
  requestId = crypto.randomUUID(),
): Promise<T> {
  signal.throwIfAborted();
  const host = await getNativeHost();
  signal.throwIfAborted();
  let started = false;
  const cancel = () => {
    if (started)
      void host.invoke("http_cancel", { requestId }).catch(() => undefined);
  };
  const onEvent = host.channel<{ kind: string }>();
  onEvent.onmessage = (event) => {
    if (event.kind === "started") {
      started = true;
      if (signal.aborted) cancel();
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await host.invoke<T>(command, {
      requestId,
      request,
      onEvent,
    });
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** 快照仅在回调期间有效，失败或取消也使用预先分配的身份精确释放。 */
export async function withPreparedHttpFile<T>(
  request: HttpFileContext & {
    path: string;
    maxBytes: number;
    transform?: FileTransform;
  },
  signal: AbortSignal,
  use: (file: PreparedHttpFile) => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID();
  const host = await getNativeHost();
  try {
    const metadata = await fileOperation<Omit<PreparedHttpFile, "id">>(
      "http_prepare_file",
      request,
      signal,
      id,
    );
    return await use({ ...metadata, id });
  } finally {
    await host
      .invoke("http_release_file", { fileId: id })
      .catch(() => undefined);
  }
}

export function httpFileRequest(
  request: HttpFileRequest,
  signal: AbortSignal,
): Promise<HttpFileResponse> {
  return fileOperation(
    "http_file_request",
    {
      ...request,
      redirect: request.redirect ?? "error",
      timeoutMs: request.timeoutMs ?? 120_000,
      maxResponseBytes: request.maxResponseBytes ?? 2 * 1024 * 1024,
    },
    signal,
  );
}
