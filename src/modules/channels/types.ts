/**
 * 本文件定义消息连接的配置、状态和适配器契约。
 * 平台身份、投递上下文与 AI 消息分离，每个对话目标独占会话，连接与平台资源按实例共享。
 */

import type { FileUIPart } from "ai";
import { z } from "zod";

export const connectionSchema = z
  .object({
    id: z.uuid().refine((value) => value === value.toLowerCase()),
    kind: z.literal("weixin"),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    accountId: z.string().min(1).max(256).nullable(),
    busyMessageMode: z.enum(["steer", "queue"]),
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
  | "configuration"
  | "model"
  | "agent"
  | "queue-full"
  | "interrupted"
  | "delivery"
  | "delivery-unknown"
  | "account-mismatch"
  | "duplicate-account";

/** 可向界面投影的稳定错误类别，不携带 token 或平台原始响应。 */
export class ChannelError extends Error {
  constructor(readonly issue: ChannelIssue) {
    super(issue);
    this.name = "ChannelError";
  }
}

export const channelTargetSchema = z
  .object({
    kind: z.enum(["direct", "group"]),
    id: z.string().min(1).max(512),
    threadId: z.string().min(1).max(512).optional(),
  })
  .strict();

/** 稳定对话地址与发送者独立；平台临时凭据只留在适配器内部。 */
export type ChannelTarget = z.infer<typeof channelTargetSchema>;

/** 对话绑定独立于连接配置；首次合规来信创建，重启后复用。 */
export const channelConversationSchema = z
  .object({
    sessionId: z.uuid(),
    target: channelTargetSchema,
  })
  .strict();
export type ChannelConversation = z.infer<typeof channelConversationSchema>;
export type ChannelSession = ChannelConnection & ChannelConversation;

export function channelTargetKey(target: ChannelTarget): string {
  return JSON.stringify([target.kind, target.id, target.threadId ?? null]);
}

export function channelTargetLabel(target: ChannelTarget): string {
  return target.threadId ? `${target.id} / ${target.threadId}` : target.id;
}

export type ChannelInbound = {
  id: string;
  senderId: string;
  text: string;
  receivedAt: number;
  target: ChannelTarget;
  attachments: ChannelAttachment[];
  /** 已物化为模型通用文件输入的图片，不包含平台下载凭据或远程地址。 */
  modelMedia?: FileUIPart[];
};

/** 附件原件属于账号 cwd；失败记录保留名称，不能伪装为可读文件。 */
export type ChannelAttachment = {
  id: string;
  name: string;
  kind: "file" | "image" | "video" | "audio";
} & ({ status: "ready"; path: string; size: number } | { status: "failed" });

/** 出站只表达内容与展示意图，目标由调用方明确指定，平台负责协议编码。 */
export type ChannelOutbound = {
  text?: string;
  attachments?: Array<{
    path: string;
    presentation: "file" | "image" | "video" | "audio";
  }>;
};

export type ChannelDeliverySource =
  | "application"
  | "agent"
  | "command"
  | "tool";

/** 平台适配器输出通用投递事实，原因不包含平台正文或凭据。 */
export type ChannelDeliveryResult = {
  status: "accepted" | "partial" | "failed" | "unknown";
  parts: Array<{ index: number; status: "accepted" | "failed" | "unknown" }>;
  reason?:
    | "network"
    | "protocol"
    | "rejected"
    | "auth"
    | "context"
    | "upload"
    | "interrupted";
  total?: number;
};

/** 由主运行绑定目标的发送能力，工具层只消费这一份投递契约。 */
export type ChannelMessageSender = (
  input: ChannelOutbound,
  signal?: AbortSignal,
) => Promise<ChannelDeliveryResult>;

export const protocolCheckpointSchema = z
  .object({
    cursor: z.string().max(262144),
    cursorScope: z.string().max(256),
    recentIds: z.array(z.string().max(4096)).max(256),
    pendingIds: z.array(z.string().max(4096)).max(16),
  })
  .strict();
export const checkpointSchema = protocolCheckpointSchema
  .extend({ conversations: z.array(channelConversationSchema) })
  .refine(
    (value) =>
      new Set(value.conversations.map((item) => item.sessionId)).size ===
        value.conversations.length &&
      new Set(value.conversations.map((item) => channelTargetKey(item.target)))
        .size === value.conversations.length,
  );
export type ChannelCheckpoint = z.infer<typeof checkpointSchema>;

export type ChannelSnapshot = {
  connection: ChannelConnection;
  status: ChannelStatus;
  issue: ChannelIssue | null;
  queued: number;
  busy: boolean;
  conversations: Array<
    ChannelConversation & { busy: boolean; queued: number; canSend: boolean }
  >;
  login?: {
    qrContent: string;
    state: "waiting" | "scanned" | "verify" | "expired";
  };
};

export type ReceiveContext = {
  signal: AbortSignal;
  cursor: string;
  /** 适配器等待准入完成后再消费后续消息或推进游标，遵守运行时背压。 */
  receive: (
    message: ChannelInbound,
    materialize?: () => Promise<ChannelInbound>,
  ) => Promise<void>;
  checkpoint: (cursor: string) => Promise<void>;
  status: (status: ChannelStatus) => void;
};

export type ChannelAdapter = {
  /** 平台判断目标所需协议上下文是否可用，不代表投递一定成功。 */
  canSend: (target: ChannelTarget) => boolean;
  /** 游标所属的平台连接资源；重新登录换资源后不能继续使用旧游标。 */
  cursorScope: string;
  receive: (context: ReceiveContext) => Promise<void>;
  send: (
    target: ChannelTarget,
    content: ChannelOutbound,
    signal: AbortSignal,
  ) => Promise<ChannelDeliveryResult>;
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
