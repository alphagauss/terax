/**
 * 本文件在 Local 永久主窗口组合连接管理、登录和会话服务。
 * 设置窗口只通过定向请求管理；配置操作串行，平台代码只在启用或扫码时加载。
 */

import i18n from "@/i18n";
import { onSharedStoreChange } from "@/lib/sharedStore";
import {
  actionSchema,
  CHANNEL_REQUEST,
  CHANNEL_RESPONSE,
  CHANNEL_SNAPSHOT,
  type ChannelAction,
  useChannelsView,
} from "@/modules/channels/client";
import { ChannelManager } from "@/modules/channels/manager";
import {
  loadCheckpoint,
  loadConnections,
  removeConnection,
  saveCheckpoint,
  saveConnection,
} from "@/modules/channels/storage";
import {
  type ChannelConnection,
  ChannelError,
  type ChannelIssue,
  type ChannelSnapshot,
  channelDelay,
} from "@/modules/channels/types";
import { currentWorkspaceBootstrap } from "@/modules/workspace-process";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { z } from "zod";

const envelopeSchema = z
  .object({
    requestId: z.uuid(),
    replyTo: z.enum(["main", "auxiliary-settings"]),
    command: actionSchema,
  })
  .strict();
type Login = {
  abort: AbortController;
  code: string;
  snapshot?: ChannelSnapshot["login"];
  task?: Promise<void>;
};

/** 启动唯一服务，返回同步解除监听、异步清理运行资源的释放函数。 */
export async function startChannelsService(
  activate: (sessionId: string) => void,
): Promise<() => Promise<void>> {
  const bootstrap = currentWorkspaceBootstrap();
  if (!bootstrap.isPrimary || bootstrap.env.kind !== "local")
    return async () => {};
  let disposed = false;
  const epoch = crypto.randomUUID();
  let connections: ChannelConnection[] = [];
  let snapshots: ChannelSnapshot[] = [];
  let serial = Promise.resolve();
  const logins = new Map<string, Login>();
  const loginErrors = new Map<string, ChannelIssue>();
  let serviceError: string | null = null;
  const manager = new ChannelManager({
    load: loadCheckpoint,
    save: saveCheckpoint,
    run: async (...args) =>
      (await import("@/modules/channels/agentSession")).runChannelTurn(...args),
    failureText: () => i18n.t("channels:runFailed"),
    adapter: async (connection) => {
      const { loadWeixinCredentials, WeixinAdapter } = await import(
        "@/modules/channels/adapters/weixin"
      );
      const credentials = await loadWeixinCredentials(connection.id);
      if (credentials.userId !== connection.accountId)
        throw new ChannelError("account-mismatch");
      return new WeixinAdapter(credentials, connection.id);
    },
    changed: (value) => {
      snapshots = value;
      publish();
    },
  });

  function publish(error?: string | null) {
    if (disposed) return;
    if (error !== undefined) serviceError = error;
    const view = {
      epoch,
      version: useChannelsView.getState().version + 1,
      snapshots: snapshots.map((snapshot) => ({
        ...snapshot,
        issue: loginErrors.get(snapshot.connection.id) ?? snapshot.issue,
        login: logins.get(snapshot.connection.id)?.snapshot,
      })),
      error: serviceError,
    };
    useChannelsView.setState(view);
    void emit(CHANNEL_SNAPSHOT, view).catch(() => undefined);
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const task = serial.then(async () => {
      if (!disposed) await work();
    });
    serial = task.catch(() => undefined);
    return task;
  }

  async function reload() {
    connections = await loadConnections();
    serviceError = null;
    await manager.configure(connections);
  }

  function connection(id: string): ChannelConnection {
    const value = connections.find((item) => item.id === id);
    if (!value) throw new ChannelError("storage");
    return value;
  }

  /** 启停与移除使用同一登录清理，停用后扫码不能再次启用连接。 */
  function cancelLogin(id: string) {
    logins.get(id)?.abort.abort();
    logins.delete(id);
    loginErrors.delete(id);
  }

  async function startLogin(id: string) {
    connection(id);
    logins.get(id)?.abort.abort();
    const login: Login = { abort: new AbortController(), code: "" };
    logins.set(id, login);
    loginErrors.delete(id);
    const { beginWeixinLogin, saveWeixinCredentials } = await import(
      "@/modules/channels/adapters/weixin"
    );
    let flow: Awaited<ReturnType<typeof beginWeixinLogin>>;
    try {
      flow = await beginWeixinLogin(id, login.abort.signal);
    } catch (error) {
      logins.delete(id);
      throw error;
    }
    login.snapshot = { qrContent: flow.qrContent, state: "waiting" };
    publish();
    login.task = (async () => {
      const deadline = Date.now() + 10 * 60_000;
      while (!login.abort.signal.aborted && Date.now() < deadline) {
        if (login.snapshot?.state === "verify" && !login.code) {
          await channelDelay(500, login.abort.signal);
          continue;
        }
        const code = login.code;
        login.code = "";
        let result: Awaited<ReturnType<typeof flow.poll>>;
        try {
          result = await flow.poll(code);
        } catch (error) {
          if (!(error instanceof ChannelError) || error.issue !== "network")
            throw error;
          await channelDelay(2000, login.abort.signal);
          continue;
        }
        login.abort.signal.throwIfAborted();
        login.snapshot = { qrContent: flow.qrContent, state: result.state };
        publish();
        const credentials = result.credentials;
        if (credentials) {
          await enqueue(async () => {
            login.abort.signal.throwIfAborted();
            const existing = connection(id);
            if (existing.accountId && existing.accountId !== credentials.userId)
              throw new ChannelError("account-mismatch");
            if (
              connections.some(
                (item) =>
                  item.id !== id &&
                  item.kind === existing.kind &&
                  item.accountId === credentials.userId,
              )
            )
              throw new ChannelError("duplicate-account");
            const updated = {
              ...existing,
              accountId: credentials.userId,
              enabled: true,
            };
            try {
              await (
                await import("@/modules/channels/agentSession")
              ).ensureChannelSession(updated);
              await manager.configure(
                connections.filter((item) => item.id !== id),
              );
              try {
                await saveWeixinCredentials(id, credentials);
                await saveConnection(updated);
                logins.delete(id);
              } finally {
                // 密钥与配置无法跨资源原子提交，任何失败都按当前配置恢复可管理的实例。
                await reload();
              }
            } catch (error) {
              throw error instanceof ChannelError
                ? error
                : new ChannelError("storage");
            }
          });
          return;
        }
        if (result.state === "expired") return;
        await channelDelay(1000, login.abort.signal);
      }
      if (login.snapshot) login.snapshot.state = "expired";
      publish();
    })().catch((error) => {
      if (!login.abort.signal.aborted) {
        logins.delete(id);
        loginErrors.set(
          id,
          error instanceof ChannelError ? error.issue : "protocol",
        );
        publish();
      }
    });
  }

  async function execute(action: ChannelAction) {
    if (action.action === "snapshot") return;
    if (action.action === "add") {
      await saveConnection({
        id: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        kind: "weixin",
        name: action.name,
        enabled: false,
        accountId: null,
        busyMessageMode: "steer",
      });
      await reload();
      return;
    }
    const target = connection(action.id);
    switch (action.action) {
      case "busy-message-mode":
        await saveConnection({ ...target, busyMessageMode: action.mode });
        await reload();
        break;
      case "enable":
        if (!action.enabled) cancelLogin(target.id);
        await saveConnection({ ...target, enabled: action.enabled });
        await reload();
        break;
      case "login":
        await startLogin(target.id);
        break;
      case "verify": {
        const login = logins.get(target.id);
        if (login) login.code = action.code;
        break;
      }
      case "cancel-login":
        cancelLogin(target.id);
        publish();
        break;
      case "reconnect":
        await manager.restart(target.id);
        break;
      case "open":
        await (
          await import("@/modules/channels/agentSession")
        ).ensureChannelSession(target);
        activate(target.sessionId);
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
        break;
      case "remove": {
        cancelLogin(target.id);
        await manager.configure(
          connections.filter((item) => item.id !== target.id),
        );
        const { deleteWeixinCredentials } = await import(
          "@/modules/channels/adapters/weixin"
        );
        await deleteWeixinCredentials(target.id);
        await removeConnection(target.id);
        await reload();
        break;
      }
    }
  }

  const unlisten = await listen<unknown>(CHANNEL_REQUEST, (event) => {
    const envelope = envelopeSchema.safeParse(event.payload);
    if (!envelope.success) return;
    const { requestId, replyTo, command } = envelope.data;
    const task =
      command.action === "snapshot"
        ? Promise.resolve()
        : enqueue(() => execute(command));
    void task
      .then(() =>
        emitTo({ kind: "WebviewWindow", label: replyTo }, CHANNEL_RESPONSE, {
          requestId,
          view: useChannelsView.getState(),
        }),
      )
      .catch((error) =>
        emitTo({ kind: "WebviewWindow", label: replyTo }, CHANNEL_RESPONSE, {
          requestId,
          error: error instanceof ChannelError ? error.issue : "storage",
        }),
      )
      .catch(() => undefined);
  });
  const unwatch = await onSharedStoreChange("channels", () =>
    enqueue(reload).catch(() => publish("storage")),
  );
  // 服务没有额外保活 timer，平台按需轮询；配置监听复用现有 shared_store。
  return async () => {
    disposed = true;
    unlisten();
    unwatch();
    for (const login of logins.values()) login.abort.abort();
    await serial;
    await manager.dispose();
    await Promise.allSettled([...logins.values()].map((login) => login.task));
  };
}
