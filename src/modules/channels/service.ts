/**
 * 本文件在 Local 永久主窗口组合连接管理、登录和会话服务。
 * 设置窗口只通过定向请求管理；配置操作串行，平台代码只在启用或扫码时加载。
 */

import i18n from "@/i18n";
import {
  channelPlatform,
  type ChannelLogin,
} from "@/modules/channels/adapters/registry";
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
    emptyReply: () => i18n.t("channels:emptyReply"),
    adapter: async (connection) =>
      channelPlatform(connection.kind).create(connection),
    materialize: async (connection, message, signal) =>
      (
        await import("@/modules/channels/inbound")
      ).materializeChannelInbound(connection, message, signal),
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

  /** 加载失败时保留明确的错误类别，修复配置后由同一入口恢复服务。 */
  async function reload() {
    try {
      connections = await loadConnections();
      serviceError = null;
      await manager.configure(connections);
    } catch (error) {
      publish(error instanceof ChannelError ? error.issue : "storage");
      throw error;
    }
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

  /** 管理一次扫码流程，验证码在请求成功前保留，网络重试不要求重复输入。 */
  async function startLogin(id: string) {
    connection(id);
    logins.get(id)?.abort.abort();
    const login: Login = { abort: new AbortController(), code: "" };
    logins.set(id, login);
    loginErrors.delete(id);
    let flow: ChannelLogin;
    try {
      flow = await channelPlatform(connection(id).kind).login(
        id,
        login.abort.signal,
      );
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
        let result: Awaited<ReturnType<typeof flow.poll>>;
        try {
          result = await flow.poll(code);
          // 请求失败时保留验证码供网络重试；不清除请求期间收到的新验证码。
          if (login.code === code) login.code = "";
        } catch (error) {
          if (!(error instanceof ChannelError) || error.issue !== "network")
            throw error;
          await channelDelay(2000, login.abort.signal);
          continue;
        }
        login.abort.signal.throwIfAborted();
        login.snapshot = { qrContent: flow.qrContent, state: result.state };
        publish();
        const credentials = result.authorization;
        if (credentials) {
          await enqueue(async () => {
            login.abort.signal.throwIfAborted();
            const existing = connection(id);
            if (
              existing.accountId &&
              existing.accountId !== credentials.accountId
            )
              throw new ChannelError("account-mismatch");
            if (
              connections.some(
                (item) =>
                  item.id !== id &&
                  item.kind === existing.kind &&
                  item.accountId === credentials.accountId,
              )
            )
              throw new ChannelError("duplicate-account");
            const updated = {
              ...existing,
              accountId: credentials.accountId,
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
                await credentials.save();
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

  /** 串行执行设置操作；新增必须先确认现有配置可读，再提交新记录。 */
  async function execute(action: ChannelAction) {
    if (action.action === "snapshot") return;
    if (action.action === "add") {
      await reload();
      const created: ChannelConnection = {
        id: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        kind: action.kind,
        name: action.name,
        enabled: false,
        accountId: null,
        busyMessageMode: "steer",
      };
      await saveConnection(created);
      // 保存成功后直接发布已提交记录，避免随后读取失败把成功新增报告成失败。
      connections = [...connections, created];
      await manager.configure(connections);
      return;
    }
    const target = connection(action.id);
    switch (action.action) {
      case "update":
        await saveConnection({
          ...target,
          name: action.name,
          busyMessageMode: action.mode,
        });
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
        try {
          await channelPlatform(target.kind).removeCredentials(target.id);
          await removeConnection(target.id);
        } finally {
          // 清理失败时配置仍存在，重新展示连接以允许用户重试删除。
          await reload();
        }
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
    enqueue(reload).catch(() => undefined),
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
