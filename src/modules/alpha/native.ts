/**
 * 本文件封装 Alpha 本机单例服务的 Tauri 命令。
 * 所有窗口通过同一组幂等接口查询和控制服务，不在前端复制生命周期状态。
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export type AlphaStatus = {
  running: boolean;
  configured: boolean;
  pythonPath: string | null;
  autoStart: boolean;
  port: number;
  archiveHash: string;
  serviceArchiveHash: string | null;
  issue: "portConflict" | null;
};

export type PythonCheck = {
  path: string;
  version: string | null;
  missingPackages: string[];
  error: string | null;
};

export type AlphaQueryParam = {
  name: string;
  value: string;
};

export type AlphaHttpRequest = {
  method: "GET" | "POST";
  path: `/api/alpha${string}`;
  query?: AlphaQueryParam[];
  body?: unknown;
};

export type AlphaHttpResponse<T = unknown> = {
  status: number;
  headers: Record<string, string>;
  body: T;
};

export type AlphaWebSocketEvent =
  | { kind: "message"; message: unknown }
  | { kind: "closed"; code: number | null; reason: string }
  | { kind: "error"; message: string };

export type AlphaWebSocketConnection = {
  readonly id: number;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
};

/** 通过服务健康检查查询 Alpha 实时状态。 */
export function getAlphaStatus(): Promise<AlphaStatus> {
  return invoke("alpha_status");
}

/** 保存 Python 解释器路径，不触发版本或依赖检查。 */
export function setAlphaPythonPath(path: string): Promise<void> {
  return invoke("alpha_set_python_path", { path });
}

/** 检查当前或显式指定的 Python 解释器。 */
export function checkAlphaPython(path?: string): Promise<PythonCheck> {
  return invoke("alpha_check_python", { path: path ?? null });
}

/** 更新共享的 Alpha 自动启动设置。 */
export function setAlphaAutoStart(enabled: boolean): Promise<void> {
  return invoke("alpha_set_auto_start", { enabled });
}

/** 幂等启动共享 Alpha 服务。 */
export function startAlpha(): Promise<AlphaStatus> {
  return invoke("alpha_start");
}

/** 幂等停止共享 Alpha 服务。 */
export function stopAlpha(): Promise<AlphaStatus> {
  return invoke("alpha_stop");
}

/** 重启共享 Alpha 服务。 */
export function restartAlpha(): Promise<AlphaStatus> {
  return invoke("alpha_restart");
}

/** 通过 Rust 固定目标代理发送通用 Alpha GET 或 POST JSON 请求。 */
export function requestAlpha<T = unknown>(
  request: AlphaHttpRequest,
): Promise<AlphaHttpResponse<T>> {
  return invoke("alpha_http_request", {
    request: {
      ...request,
      query: request.query ?? [],
      body: request.body ?? null,
    },
  });
}

/**
 * 建立完整双向的 Alpha JSON WebSocket。
 *
 * 连接关闭后 `send` 会拒绝，调用 `close` 始终幂等。重连和 HTTP 状态恢复由调用方负责。
 */
export async function openAlphaWebSocket(
  path: `/api/alpha${string}`,
  onEvent: (event: AlphaWebSocketEvent) => void,
  query: AlphaQueryParam[] = [],
): Promise<AlphaWebSocketConnection> {
  const channel = new Channel<AlphaWebSocketEvent>();
  let closed = false;
  channel.onmessage = (event) => {
    if (event.kind === "closed") {
      closed = true;
    }
    onEvent(event);
  };
  const id = await invoke<number>("alpha_ws_open", {
    path,
    query,
    onEvent: channel,
  });

  return {
    id,
    async send(message: unknown) {
      if (closed) {
        throw new Error("Alpha WebSocket is closed");
      }
      await invoke("alpha_ws_send", { id, message });
    },
    async close() {
      if (closed) return;
      closed = true;
      await invoke("alpha_ws_close", { id });
    },
  };
}
