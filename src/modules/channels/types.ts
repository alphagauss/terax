/**
 * 本文件定义消息连接的配置、状态和适配器契约。
 * 平台身份、投递上下文与 AI 消息分离，每个连接独占一个固定会话。
 */

import { z } from "zod";

export const connectionSchema = z
  .object({
    id: z.uuid().refine((value) => value === value.toLowerCase()),
    kind: z.literal("weixin"),
    name: z.string().trim().min(1).max(80),
    sessionId: z.uuid().refine((value) => value === value.toLowerCase()),
    enabled: z.boolean(),
    accountId: z.string().max(256).nullable(),
  })
  .strict();

export type ChannelConnection = z.infer<typeof connectionSchema>;
export type ChannelStatus =
  | "disabled"
  | "connecting"
  | "online"
  | "reconnecting"
  | "login-required"
  | "error";
export type ChannelIssue =
  | "network"
  | "auth"
  | "protocol"
  | "storage"
  | "model"
  | "agent"
  | "queue-full"
  | "interrupted"
  | "delivery"
  | "account-mismatch"
  | "duplicate-account"
  | "limit";

/** 可向界面投影的稳定错误类别，不携带 token 或平台原始响应。 */
export class ChannelError extends Error {
  constructor(readonly issue: ChannelIssue) {
    super(issue);
    this.name = "ChannelError";
  }
}

export type ChannelInbound = {
  id: string;
  senderId: string;
  text: string;
  receivedAt: number;
  replyContext: string;
};

export const checkpointSchema = z
  .object({
    cursor: z.string().max(262144),
    cursorScope: z.string().max(256),
    recentIds: z.array(z.string().max(512)).max(256),
    pendingIds: z.array(z.string().max(512)).max(16),
  })
  .strict();
export type ChannelCheckpoint = z.infer<typeof checkpointSchema>;

export type ChannelSnapshot = {
  connection: ChannelConnection;
  status: ChannelStatus;
  issue: ChannelIssue | null;
  queued: number;
  busy: boolean;
  login?: {
    qrContent: string;
    state: "waiting" | "scanned" | "verify" | "expired";
  };
};

export type ReceiveContext = {
  signal: AbortSignal;
  cursor: string;
  receive: (message: ChannelInbound) => Promise<void>;
  checkpoint: (cursor: string) => Promise<void>;
  status: (status: ChannelStatus) => void;
};

export type ChannelAdapter = {
  /** 游标所属的平台连接资源；重新登录换资源后不能继续使用旧游标。 */
  cursorScope: string;
  receive: (context: ReceiveContext) => Promise<void>;
  send: (
    message: ChannelInbound,
    text: string,
    signal: AbortSignal,
  ) => Promise<void>;
};

/** 可取消等待只用于协议退避，取消后立即清理 timer 和监听器。 */
export function channelDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
