/**
 * 本文件验证登录替换失败后主窗口服务仍可管理已有连接。
 * 使用真实 Manager 和设置请求链，只替换平台、密钥和磁盘边界。
 */

import { requestChannels, useChannelsView } from "@/modules/channels/client";
import { startChannelsService } from "@/modules/channels/service";
import type {
  ChannelCheckpoint,
  ChannelConnection,
} from "@/modules/channels/types";
import { expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  saveCredentials: vi.fn(),
  checkpoint: {
    cursor: "old-cursor",
    cursorScope: "old-bot",
    recentIds: [],
    pendingIds: [],
  } as ChannelCheckpoint,
  connection: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    kind: "weixin",
    name: "WeChat",
    accountId: "owner",
    busyMessageMode: "queue" as const,
    enabled: true,
  } as ChannelConnection,
}));

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({
    isPrimary: true,
    env: { kind: "local" },
  }),
}));
vi.mock("@tauri-apps/api/event", () => {
  const emit = async (name: string, payload: unknown) => {
    for (const listener of io.listeners.get(name) ?? []) listener({ payload });
  };
  return {
    emit,
    emitTo: async (_target: unknown, name: string, payload: unknown) =>
      emit(name, payload),
    listen: async (
      name: string,
      callback: (event: { payload: unknown }) => void,
    ) => {
      const listeners = io.listeners.get(name) ?? new Set();
      io.listeners.set(name, listeners);
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "auxiliary-settings" }),
}));
vi.mock("@/lib/sharedStore", () => ({
  onSharedStoreChange: async (_store: string, reload: () => Promise<void>) => {
    await reload();
    return () => {};
  },
}));
vi.mock("@/modules/channels/storage", () => ({
  loadConnections: async () => [structuredClone(io.connection)],
  loadCheckpoint: async () => structuredClone(io.checkpoint),
  saveCheckpoint: async (_id: string, checkpoint: ChannelCheckpoint) => {
    io.checkpoint = structuredClone(checkpoint);
  },
  saveConnection: async (connection: ChannelConnection) => {
    io.connection = connection;
  },
  removeConnection: vi.fn(),
}));
vi.mock("@/modules/channels/agentSession", () => ({
  ensureChannelSession: vi.fn(),
}));
vi.mock("@/modules/channels/adapters/weixin", () => ({
  loadWeixinCredentials: async () => ({ userId: "owner", botId: "old-bot" }),
  saveWeixinCredentials: io.saveCredentials,
  beginWeixinLogin: async () => ({
    qrContent: "scan",
    poll: async () => ({
      state: "scanned",
      credentials: { userId: "owner", botId: "new-bot" },
    }),
  }),
  WeixinAdapter: class {
    cursorScope = "old-bot";
    async receive(context: {
      signal: AbortSignal;
      status: (status: string) => void;
    }) {
      context.status("online");
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    }
    async send() {}
  },
}));

it("restores the configured connection when replacing its credentials fails", async () => {
  io.saveCredentials.mockRejectedValue(new Error("keychain unavailable"));
  const dispose = await startChannelsService(() => {});
  try {
    await requestChannels({ action: "login", id: io.connection.id });
    await vi.waitFor(() =>
      expect(useChannelsView.getState().snapshots[0]).toMatchObject({
        connection: {
          id: io.connection.id,
          sessionId: io.connection.sessionId,
        },
        status: "online",
        issue: "storage",
      }),
    );
    expect(io.checkpoint.cursor).toBe("old-cursor");
    expect(useChannelsView.getState().snapshots).toHaveLength(1);
    const view = await requestChannels({
      action: "enable",
      id: io.connection.id,
      enabled: false,
    });
    expect(view.snapshots[0].status).toBe("disabled");
  } finally {
    await dispose();
  }
});
