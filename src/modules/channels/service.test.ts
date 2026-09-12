/**
 * 本文件验证配置失败、验证码重试及删除失败后的连接可管理性。
 * 使用真实 Manager 和设置请求链，只替换平台、密钥和磁盘边界。
 */

import { requestChannels, useChannelsView } from "@/modules/channels/client";
import { startChannelsService } from "@/modules/channels/service";
import {
  ChannelError,
  type ChannelCheckpoint,
  type ChannelConnection,
} from "@/modules/channels/types";
import { beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  saveCredentials: vi.fn(),
  poll: vi.fn(),
  deleteState: vi.fn(),
  stores: new Map<string, Record<string, unknown>>(),
  files: new Map<string, string>(),
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
  readSharedStore: async (store: string) =>
    structuredClone(io.stores.get(store) ?? {}),
  setSharedStoreKey: async (store: string, key: string, value: unknown) => {
    io.stores.set(store, {
      ...io.stores.get(store),
      [key]: structuredClone(value),
    });
  },
  deleteSharedStoreKey: async (store: string, key: string) => {
    delete io.stores.get(store)?.[key];
  },
  mutateSharedStore: async (store: string, changes: { key: string }[]) => {
    for (const change of changes) delete io.stores.get(store)?.[change.key];
  },
}));
vi.mock("@/lib/nativeHost", () => ({
  invokeNative: async (command: string, args: Record<string, unknown>) => {
    const path = args.path as string;
    if (command === "workspace_prepare_default_root") return "/state";
    if (command === "fs_stat")
      return io.files.has(path) ? { kind: "file" } : null;
    if (command === "fs_read_file")
      return { kind: "text", content: io.files.get(path) };
    if (command === "fs_write_file") {
      io.files.set(path, args.content as string);
      return 0;
    }
    if (command === "fs_delete") return io.deleteState(path);
    throw new Error(`Unexpected command: ${command}`);
  },
}));
vi.mock("@/modules/channels/agentSession", () => ({
  ensureChannelSession: vi.fn(),
}));
vi.mock("@/modules/channels/adapters/registry", () => ({
  channelPlatform: () => ({
    create: async () => ({
      cursorScope: "old-bot",
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
      },
      async send() {},
    }),
    async login(id: string) {
      return {
        qrContent: "scan",
        async poll(code?: string) {
          const result = await io.poll(code);
          return {
            state: result.state,
            authorization: result.credentials
              ? {
                  accountId: result.credentials.userId,
                  save: () => io.saveCredentials(id, result.credentials),
                }
              : undefined,
          };
        },
      };
    },
    removeCredentials: vi.fn(),
  }),
}));

beforeEach(() => {
  io.stores.clear();
  io.stores.set("channels", {
    [io.connection.id]: structuredClone(io.connection),
  });
  io.files.clear();
  io.files.set(
    `/state/${io.connection.id}.json`,
    JSON.stringify(io.checkpoint),
  );
  io.saveCredentials.mockReset();
  io.deleteState.mockReset().mockImplementation(async (path: string) => {
    io.files.delete(path);
  });
  io.poll.mockReset().mockResolvedValue({
    state: "scanned",
    credentials: { userId: "owner", botId: "new-bot" },
  });
  useChannelsView.setState({
    epoch: "",
    version: 0,
    snapshots: [],
    error: null,
  });
});

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
    expect(
      JSON.parse(io.files.get(`/state/${io.connection.id}.json`) ?? "null"),
    ).toMatchObject({ cursor: "old-cursor" });
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

it("配置无效时拒绝新增且不写入，修正当前记录后可正常新增", async () => {
  const invalid: Record<string, unknown> = { ...io.connection };
  delete invalid.busyMessageMode;
  io.stores.set("channels", { [io.connection.id]: invalid });
  const dispose = await startChannelsService(() => {});
  try {
    expect(useChannelsView.getState().error).toBe("configuration");
    await expect(
      requestChannels({ action: "add", kind: "weixin", name: "test" }),
    ).rejects.toThrow("configuration");
    expect(io.stores.get("channels")).toEqual({ [io.connection.id]: invalid });
    io.stores.set("channels", {
      [io.connection.id]: structuredClone(io.connection),
    });
    const view = await requestChannels({
      action: "add",
      kind: "weixin",
      name: "test",
    });
    expect(view.error).toBeNull();
    expect(view.snapshots).toHaveLength(2);
    expect(Object.keys(io.stores.get("channels") ?? {})).toHaveLength(2);
  } finally {
    await dispose();
  }
});

it("拒绝同一账号的重复配置，避免两个运行实例共享账号 cwd", async () => {
  const duplicate = {
    ...io.connection,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  io.stores.set("channels", {
    [io.connection.id]: io.connection,
    [duplicate.id]: duplicate,
  });
  const dispose = await startChannelsService(() => {});
  try {
    expect(useChannelsView.getState().error).toBe("configuration");
    expect(useChannelsView.getState().snapshots).toEqual([]);
  } finally {
    await dispose();
  }
});

it("验证码请求短暂断网后自动重试并继续登录", async () => {
  vi.useFakeTimers();
  io.poll
    .mockReset()
    .mockResolvedValueOnce({ state: "verify" })
    .mockRejectedValueOnce(new ChannelError("network"))
    .mockResolvedValue({
      state: "scanned",
      credentials: { userId: "owner", botId: "new-bot" },
    });
  const dispose = await startChannelsService(() => {});
  try {
    await requestChannels({ action: "login", id: io.connection.id });
    await vi.advanceTimersByTimeAsync(1000);
    await requestChannels({
      action: "verify",
      id: io.connection.id,
      code: "123456",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(io.poll.mock.calls.map(([code]) => code)).toEqual([
      "",
      "123456",
      "123456",
    ]);
    expect(io.saveCredentials).toHaveBeenCalledOnce();
    expect(useChannelsView.getState().snapshots[0].login).toBeUndefined();
  } finally {
    await dispose();
    vi.useRealTimers();
  }
});

it("删除清理失败时保留可重试连接，重试后清除其状态、路由与模型配置", async () => {
  io.stores.set("channels", {
    [io.connection.id]: { ...io.connection, enabled: false },
  });
  io.stores.set("settings", {
    [`network.channel:${io.connection.id}`]: "direct",
    [`modelUsage:channel:${io.connection.id}:model`]: {
      providerId: "builtin:deepseek",
      modelId: "test",
    },
    [`modelUsage:channel:${io.connection.id}:parameters:["builtin:deepseek","test"]`]:
      { effort: "low" },
    theme: "dark",
  });
  io.deleteState.mockRejectedValueOnce(new Error("state is busy"));
  const dispose = await startChannelsService(() => {});
  try {
    await expect(
      requestChannels({ action: "remove", id: io.connection.id }),
    ).rejects.toThrow("storage");
    expect(useChannelsView.getState().snapshots[0].connection.id).toBe(
      io.connection.id,
    );
    expect(io.stores.get("channels")?.[io.connection.id]).toBeDefined();
    const view = await requestChannels({
      action: "remove",
      id: io.connection.id,
    });
    expect(view.snapshots).toEqual([]);
    expect(io.files.has(`/state/${io.connection.id}.json`)).toBe(false);
    expect(io.stores.get("settings")).toEqual({ theme: "dark" });
    expect(io.stores.get("channels")).toEqual({});
  } finally {
    await dispose();
  }
});
