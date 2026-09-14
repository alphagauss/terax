/**
 * 本文件连接设置 WebView 与 Local 主窗口的消息服务。
 * 请求先登记响应监听再投递，带有限超时；客户端只保存展示快照，不启动连接。
 */

import type { ChannelSnapshot } from "@/modules/channels/types";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { z } from "zod";
import { create } from "zustand";

export const CHANNEL_REQUEST = "terax://channels-request";
export const CHANNEL_RESPONSE = "terax://channels-response";
export const CHANNEL_SNAPSHOT = "terax://channels-snapshot";

export const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("send"),
      id: z.uuid(),
      sessionId: z.uuid(),
      content: z
        .object({
          text: z.string().max(32000).optional(),
          attachments: z
            .array(
              z
                .object({
                  path: z.string().min(1),
                  presentation: z.enum(["file", "image", "video", "audio"]),
                })
                .strict(),
            )
            .max(16)
            .optional(),
        })
        .strict()
        .refine((value) =>
          Boolean(value.text?.trim() || value.attachments?.length),
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      id: z.uuid(),
      name: z.string().trim().min(1).max(80),
      mode: z.enum(["steer", "queue"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("open"),
      id: z.uuid(),
      sessionId: z.uuid().optional(),
    })
    .strict(),
  z.object({ action: z.literal("snapshot") }).strict(),
  z
    .object({
      action: z.literal("add"),
      kind: z.literal("weixin"),
      name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({ action: z.literal("enable"), id: z.uuid(), enabled: z.boolean() })
    .strict(),
  z
    .object({
      action: z.enum(["login", "cancel-login", "reconnect", "remove"]),
      id: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("verify"),
      id: z.uuid(),
      code: z.string().regex(/^\d{1,8}$/),
    })
    .strict(),
]);
export type ChannelAction = z.infer<typeof actionSchema>;
export type ChannelView = {
  epoch: string;
  version: number;
  snapshots: ChannelSnapshot[];
  error: string | null;
};

export const useChannelsView = create<ChannelView>(() => ({
  epoch: "",
  version: 0,
  snapshots: [],
  error: null,
}));

/** 查询或管理主窗口服务，超时后回收本次监听。 */
export async function requestChannels(
  action: ChannelAction,
): Promise<ChannelView> {
  const requestId = crypto.randomUUID();
  let finish: (value: { view?: ChannelView; error?: string }) => void =
    () => {};
  const response = new Promise<{ view?: ChannelView; error?: string }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const unlisten = await listen<{
    requestId: string;
    view?: ChannelView;
    error?: string;
  }>(CHANNEL_RESPONSE, (event) => {
    if (event.payload.requestId === requestId) finish(event.payload);
  });
  const timer = setTimeout(() => finish({ error: "unavailable" }), 30_000);
  try {
    await emitTo({ kind: "WebviewWindow", label: "main" }, CHANNEL_REQUEST, {
      requestId,
      replyTo: getCurrentWebviewWindow().label,
      command: actionSchema.parse(action),
    });
    const result = await response;
    if (result.error || !result.view)
      throw new Error(result.error ?? "unavailable");
    acceptView(result.view);
    return result.view;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

function acceptView(view: ChannelView) {
  if (
    view.epoch !== useChannelsView.getState().epoch ||
    view.version >= useChannelsView.getState().version
  )
    useChannelsView.setState(view);
}

/** 设置页按需订阅，关闭页面后不保留额外监听或轮询。 */
export async function subscribeChannelsView(): Promise<() => void> {
  const unlisten = await listen<ChannelView>(CHANNEL_SNAPSHOT, (event) =>
    acceptView(event.payload),
  );
  try {
    await requestChannels({ action: "snapshot" });
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}

/** 应用发送只等待请求保存和受理，平台完成状态由会话历史呈现。 */
export async function sendChannelContent(
  request: { connectionId: string } & Omit<
    Extract<ChannelAction, { action: "send" }>,
    "action" | "id"
  >,
): Promise<void> {
  const { connectionId, ...content } = request;
  await requestChannels({ action: "send", id: connectionId, ...content });
}

/** 设置页和状态入口只切换面板选择，不改变 Agent 当前会话。 */
export const useChannelSelection = create<{ connectionId: string }>(() => ({
  connectionId: "",
}));
