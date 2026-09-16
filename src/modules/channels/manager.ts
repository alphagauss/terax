/**
 * 本文件管理多连接的独立接收任务与有界消息队列。
 * 对话独立执行、对话内串行或引导当前轮；接收身份先落盘，异常退出不重放有副作用的任务。
 */

import { channelSessionId } from "@/modules/channels/identity";
import type { SteeringReceipt } from "@/modules/ai/lib/turnInbox";
import { bindChannelDelivery } from "@/modules/channels/delivery";
import {
  type ChannelAdapter,
  type ChannelCheckpoint,
  type ChannelConnection,
  type ChannelConversation,
  type ChannelSession,
  type ChannelIssue,
  channelTargetKey,
  ChannelError,
  type ChannelInbound,
  type ChannelSnapshot,
  type ChannelTarget,
  type ChannelOutbound,
  type ChannelDeliveryResult,
  type ChannelDeliverySource,
} from "@/modules/channels/types";

type Dependencies = {
  deliver: (
    connection: ChannelSession,
    content: ChannelOutbound,
    send: (deliveryId: string) => Promise<ChannelDeliveryResult>,
    source: ChannelDeliverySource,
  ) => Promise<ChannelDeliveryResult>;
  adapter: (connection: ChannelConnection) => Promise<ChannelAdapter>;
  materialize?: (
    connection: ChannelConnection,
    message: ChannelInbound,
    signal: AbortSignal,
  ) => Promise<ChannelInbound>;
  run: (
    connection: ChannelSession,
    message: ChannelInbound,
    signal: AbortSignal,
    ready: (steer: (message: ChannelInbound) => SteeringReceipt | null) => void,
  ) => Promise<string | null>;
  command?: (
    connection: ChannelSession,
    message: ChannelInbound,
    signal: AbortSignal,
  ) => Promise<string | null>;
  load: (connection: ChannelConnection) => Promise<ChannelCheckpoint>;
  save: (
    connection: ChannelConnection,
    checkpoint: ChannelCheckpoint,
  ) => Promise<void>;
  failureText: (error: unknown) => string;
  emptyReply: () => string;
  changed: (snapshots: ChannelSnapshot[]) => void;
};

type ConversationRuntime = {
  binding: ChannelConversation;
  queue: ChannelInbound[];
  busy: boolean;
  issue: ChannelIssue | null;
  deliveryIssue: {
    id?: string;
    status: "delivery" | "delivery-unknown";
  } | null;
  blocked: boolean;
  active: Promise<void> | null;
  steer: ((message: ChannelInbound) => SteeringReceipt | null) | null;
  command: ((message: ChannelInbound) => Promise<boolean>) | null;
  groupedIds: string[];
  pendingIds: Set<string>;
  generation: number;
};
type Runtime = {
  snapshot: Pick<ChannelSnapshot, "connection" | "status" | "issue">;
  abort: AbortController;
  conversations: Map<string, ConversationRuntime>;
  checkpoint: ChannelCheckpoint;
  writes: Promise<void>;
  sends: Promise<void>;
  inbound: Promise<void>;
  receiver: Promise<void>;
  adapter: ChannelAdapter | null;
  wake: (() => void) | null;
};

function conversationRuntime(
  binding: ChannelConversation,
): ConversationRuntime {
  return {
    binding,
    queue: [],
    busy: false,
    issue: null,
    deliveryIssue: null,
    blocked: false,
    active: null,
    steer: null,
    command: null,
    groupedIds: [],
    pendingIds: new Set(),
    generation: 0,
  };
}
function messageIdentity(message: ChannelInbound): string {
  return JSON.stringify([channelTargetKey(message.target), message.id]);
}

/** 管理实例生命周期，不依赖 React、窗口可见性或具体平台协议。 */
export class ChannelManager {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(private readonly deps: Dependencies) {}

  /** 仅资源身份与启停变化重建实例；名称和消息策略热更新，保留接收任务与在途消息。 */
  async configure(connections: readonly ChannelConnection[]): Promise<void> {
    for (const [id, runtime] of this.runtimes) {
      const next = connections.find((connection) => connection.id === id);
      const current = runtime.snapshot.connection;
      if (
        next &&
        next.kind === current.kind &&
        next.enabled === current.enabled &&
        next.accountId === current.accountId
      ) {
        runtime.snapshot.connection = next;
        continue;
      }
      await this.stop(runtime);
      this.runtimes.delete(id);
    }
    for (const connection of connections) {
      if (this.runtimes.has(connection.id)) continue;
      const runtime: Runtime = {
        snapshot: {
          connection,
          status: connection.enabled ? "connecting" : "disabled",
          issue: null,
        },
        abort: new AbortController(),
        conversations: new Map(),
        checkpoint: {
          conversations: [],
          cursor: "",
          cursorScope: "",
          recentIds: [],
          pendingIds: [],
        },
        writes: Promise.resolve(),
        sends: Promise.resolve(),
        inbound: Promise.resolve(),
        receiver: Promise.resolve(),
        adapter: null,
        wake: null,
      };
      this.runtimes.set(connection.id, runtime);
      runtime.receiver = this.receive(runtime);
    }
    this.publish();
  }

  /** 同配置重连也先结束旧任务，不产生两个同时消费的轮询。 */
  async restart(id: string): Promise<void> {
    const connections = [...this.runtimes.values()].map(
      (runtime) => runtime.snapshot.connection,
    );
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await this.stop(runtime);
      this.runtimes.delete(id);
    }
    await this.configure(connections);
  }

  /** 结束全部接收与在途执行，等待原生请求取消和会话终态提交。 */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => this.stop(runtime)),
    );
    this.runtimes.clear();
    this.publish();
  }

  /** 所有入口共用实例队列，一次内容的多项投递不被其他请求穿插。 */
  send(
    id: string,
    target: ChannelTarget,
    content: ChannelOutbound,
    signal?: AbortSignal,
    deliveryId?: string,
  ): Promise<ChannelDeliveryResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime?.adapter || runtime.abort.signal.aborted)
      return Promise.reject(new ChannelError("delivery"));
    const adapter = runtime.adapter;
    const destination = structuredClone(target);
    const input = structuredClone(content);
    const sending = runtime.sends.then(async () => {
      const combined = signal
        ? AbortSignal.any([signal, runtime.abort.signal])
        : runtime.abort.signal;
      combined.throwIfAborted();
      let result: ChannelDeliveryResult;
      try {
        result = await adapter.send(destination, input, combined);
      } catch {
        combined.throwIfAborted();
        result = { status: "unknown", parts: [] };
      }
      const conversation = runtime.conversations.get(
        channelTargetKey(destination),
      );
      if (conversation) {
        conversation.deliveryIssue =
          result.status === "accepted"
            ? null
            : {
                id: deliveryId,
                status:
                  result.status === "unknown" ? "delivery-unknown" : "delivery",
              };
        this.publish();
      }
      return result;
    });
    runtime.sends = sending.then(
      () => {},
      () => {},
    );
    return sending;
  }

  /** 只清除被处理记录的当前提示，不能误清发送期间产生的新问题。 */
  dismissDeliveryIssues(
    id: string,
    target: ChannelTarget,
    deliveryIds: readonly string[],
  ) {
    const conversation = this.runtimes
      .get(id)
      ?.conversations.get(channelTargetKey(target));
    if (
      conversation?.deliveryIssue?.id &&
      deliveryIds.includes(conversation.deliveryIssue.id)
    ) {
      conversation.deliveryIssue = null;
      this.publish();
    }
  }

  private async stop(runtime: Runtime): Promise<void> {
    runtime.abort.abort();
    runtime.wake?.();
    for (const conversation of runtime.conversations.values())
      conversation.queue = [];
    await Promise.allSettled([
      runtime.receiver,
      runtime.inbound,
      ...[...runtime.conversations.values()].map(
        (conversation) => conversation.active,
      ),
      runtime.writes,
      runtime.sends,
    ]);
  }

  private publish() {
    this.deps.changed(
      [...this.runtimes.values()].map((runtime) => {
        const conversations = [...runtime.conversations.values()];
        return {
          ...runtime.snapshot,
          issue:
            runtime.snapshot.issue ??
            conversations.find((conversation) => conversation.issue)?.issue ??
            conversations.find((conversation) => conversation.deliveryIssue)
              ?.deliveryIssue?.status ??
            null,
          busy: conversations.some((conversation) => conversation.busy),
          queued: conversations.reduce(
            (count, conversation) => count + conversation.queue.length,
            0,
          ),
          conversations: conversations.map((conversation) => ({
            ...conversation.binding,
            busy: conversation.busy,
            queued: conversation.queue.length,
          })),
        };
      }),
    );
  }

  /** 检查点失效后停止该实例，保留磁盘上的未完成身份，其他连接仍可调度。 */
  private failStorage(runtime: Runtime): void {
    runtime.snapshot.status = "error";
    runtime.snapshot.issue = "storage";
    runtime.abort.abort();
    runtime.wake?.();
    for (const conversation of runtime.conversations.values())
      conversation.queue = [];
    this.publish();
  }

  /** 快照在提交时复制，慢写入不会读到稍后变化的队列身份。 */
  private persist(runtime: Runtime): Promise<void> {
    const checkpoint = structuredClone(runtime.checkpoint);
    const writing = runtime.writes
      .then(() => this.deps.save(runtime.snapshot.connection, checkpoint))
      .catch((error) => {
        if (!runtime.abort.signal.aborted) this.failStorage(runtime);
        throw error;
      });
    runtime.writes = writing;
    return writing;
  }

  private async receive(runtime: Runtime): Promise<void> {
    const { connection } = runtime.snapshot;
    const signal = runtime.abort.signal;
    try {
      runtime.checkpoint = await this.deps.load(connection);
      for (const binding of runtime.checkpoint.conversations)
        runtime.conversations.set(
          channelTargetKey(binding.target),
          conversationRuntime(binding),
        );
      this.publish();
      signal.throwIfAborted();
      if (!connection.enabled) return;
      if (runtime.checkpoint.pendingIds.length) {
        runtime.snapshot.issue = "interrupted";
        runtime.checkpoint.pendingIds = [];
        await this.persist(runtime);
      }
      runtime.adapter = await this.deps.adapter(connection);
      signal.throwIfAborted();
      if (runtime.checkpoint.cursorScope !== runtime.adapter.cursorScope) {
        runtime.checkpoint.cursorScope = runtime.adapter.cursorScope;
        runtime.checkpoint.cursor = "";
        await this.persist(runtime);
      }
      await runtime.adapter.receive({
        signal,
        cursor: runtime.checkpoint.cursor,
        status: (status) => {
          if (signal.aborted || runtime.snapshot.status === status) return;
          runtime.snapshot.status = status;
          this.publish();
        },
        checkpoint: async (cursor) => {
          if (runtime.checkpoint.cursor === cursor) return;
          runtime.checkpoint.cursor = cursor;
          await this.persist(runtime);
        },
        receive: (message, materialize) => {
          const key = channelTargetKey(message.target);
          const generation = runtime.conversations.get(key)?.generation ?? 0;
          // 入站准入串行，执行仍按对话并行；统一保证去重、附件准备和命令接入顺序。
          const receiving = runtime.inbound.then(async () => {
            signal.throwIfAborted();
            const identity = messageIdentity(message);
            if (runtime.checkpoint.recentIds.includes(identity)) {
              this.publish();
              return;
            }
            let conversation = runtime.conversations.get(key);
            if (!conversation) {
              const binding: ChannelConversation = {
                sessionId: await channelSessionId(connection, message.target),
                target: structuredClone(message.target),
              };
              conversation = conversationRuntime(binding);
              runtime.conversations.set(key, conversation);
              runtime.checkpoint.conversations.push(binding);
            }
            while (runtime.checkpoint.pendingIds.length >= 16) {
              runtime.snapshot.issue = "queue-full";
              this.publish();
              await new Promise<void>((resolve) => {
                runtime.wake = resolve;
              });
              runtime.wake = null;
              signal.throwIfAborted();
            }
            if (runtime.snapshot.issue === "queue-full")
              runtime.snapshot.issue = null;
            runtime.checkpoint.recentIds = [
              ...runtime.checkpoint.recentIds,
              identity,
            ].slice(-256);
            // 等待队列空位期间的消息也属于被中止的轮次，只记录去重身份。
            if (generation !== conversation.generation) {
              await this.persist(runtime);
              return;
            }
            runtime.checkpoint.pendingIds.push(identity);
            conversation.pendingIds.add(identity);
            await this.persist(runtime);
            signal.throwIfAborted();
            // 中止还覆盖已经登记身份、但仍在等待写盘的入站消息。
            if (generation !== conversation.generation) return;
            try {
              if (materialize) message = await materialize();
              signal.throwIfAborted();
              if (generation !== conversation.generation) return;
              if (this.deps.materialize)
                message = await this.deps.materialize(
                  connection,
                  message,
                  signal,
                );
              signal.throwIfAborted();
              if (generation !== conversation.generation) return;
              if (await conversation.command?.(message)) return;
            } catch (error) {
              signal.throwIfAborted();
              conversation.issue =
                error instanceof ChannelError ? error.issue : "agent";
              conversation.blocked = true;
              await this.completeMessages(runtime, conversation, [identity]);
              return;
            }
            signal.throwIfAborted();
            if (generation !== conversation.generation) return;
            conversation.queue.push(message);
            conversation.blocked = false;
            this.publish();
            this.guide(runtime, conversation);
            void this.pump(runtime, conversation);
          });
          runtime.inbound = receiving.catch(() => undefined);
          return receiving;
        },
      });
    } catch (error) {
      if (!signal.aborted) {
        runtime.snapshot.issue =
          error instanceof ChannelError ? error.issue : "storage";
        runtime.snapshot.status =
          runtime.snapshot.issue === "auth" ? "login-required" : "error";
        if (runtime.snapshot.issue === "storage") this.failStorage(runtime);
        else this.publish();
      }
    }
  }

  /** 只结清指定对话的消息身份，释放共享容量后保存检查点。 */
  private async completeMessages(
    runtime: Runtime,
    conversation: ConversationRuntime,
    identities: readonly string[],
  ): Promise<void> {
    runtime.checkpoint.pendingIds = runtime.checkpoint.pendingIds.filter(
      (id) => !identities.includes(id),
    );
    for (const id of identities) conversation.pendingIds.delete(id);
    runtime.wake?.();
    await this.persist(runtime);
    this.publish();
  }

  /** 各对话独立推进 Agent，实例仅在真正投递时共享发送队列。 */
  private async pump(
    runtime: Runtime,
    conversation: ConversationRuntime,
  ): Promise<void> {
    if (conversation.busy) return;
    conversation.busy = true;
    try {
      while (
        !runtime.abort.signal.aborted &&
        runtime.adapter &&
        !conversation.blocked &&
        conversation.queue.length
      ) {
        const message = conversation.queue.shift();
        if (!message) break;
        conversation.groupedIds = [messageIdentity(message)];
        this.publish();
        conversation.active = this.execute(runtime, conversation, message);
        await conversation.active;
        conversation.active = null;
      }
    } finally {
      conversation.busy = false;
      this.publish();
    }
  }

  /** 只把已被会话接纳的补充移出传输队列，它们与本轮共用一次最终回复。 */
  private guide(runtime: Runtime, conversation: ConversationRuntime): void {
    if (
      runtime.snapshot.connection.busyMessageMode !== "steer" ||
      !conversation.steer
    )
      return;
    while (conversation.queue.length) {
      const message = conversation.queue[0];
      const receipt = conversation.steer(message);
      if (!receipt) break;
      conversation.queue.shift();
      conversation.groupedIds.push(messageIdentity(message));
    }
    this.publish();
  }

  private async execute(
    runtime: Runtime,
    conversation: ConversationRuntime,
    message: ChannelInbound,
  ): Promise<void> {
    const signal = runtime.abort.signal;
    let delivering = false;
    if (!runtime.adapter) return;
    const delivery = bindChannelDelivery(
      conversation.binding.sessionId,
      (target, content, callSignal, source) =>
        this.deps.deliver(
          { ...runtime.snapshot.connection, ...conversation.binding },
          content,
          (deliveryId) =>
            this.send(
              runtime.snapshot.connection.id,
              target,
              content,
              callSignal,
              deliveryId,
            ),
          source,
        ),
      conversation.binding.target,
      signal,
    );
    let commandTask: Promise<boolean> | undefined;
    const handleCommand = async (input: ChannelInbound): Promise<boolean> => {
      if (!this.deps.command) return false;
      const text = await this.deps.command(
        { ...runtime.snapshot.connection, ...conversation.binding },
        input,
        signal,
      );
      if (text === null) return false;
      signal.throwIfAborted();
      await delivery.reply(text);
      await this.completeMessages(runtime, conversation, [
        messageIdentity(input),
      ]);
      return true;
    };
    conversation.command = (input) => {
      commandTask = handleCommand(input);
      return commandTask;
    };
    try {
      const text = await this.deps.run(
        { ...runtime.snapshot.connection, ...conversation.binding },
        message,
        signal,
        (steer) => {
          conversation.steer = steer;
          this.guide(runtime, conversation);
        },
      );
      conversation.steer = null;
      conversation.command = null;
      await commandTask;
      signal.throwIfAborted();
      if (text === null) {
        conversation.generation++;
        conversation.groupedIds.push(...conversation.pendingIds);
        conversation.queue = [];
        this.publish();
        return;
      }
      delivering = true;
      if (text) await delivery.final(text);
      else if (!delivery.accepted)
        await delivery.failure(this.deps.emptyReply());
      if (runtime.snapshot.issue === "interrupted")
        runtime.snapshot.issue = null;
      if (!conversation.blocked) conversation.issue = null;
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof ChannelError && error.issue === "storage") {
          conversation.issue = "storage";
          conversation.blocked = true;
          return;
        }
        conversation.issue =
          error instanceof ChannelError ? error.issue : "agent";
        if (!delivering) {
          try {
            await delivery.failure(this.deps.failureText(error));
          } catch (error) {
            if (
              !signal.aborted &&
              error instanceof ChannelError &&
              error.issue === "storage"
            ) {
              conversation.issue = "storage";
              conversation.blocked = true;
            }
          }
        }
      }
    } finally {
      conversation.command = null;
      await commandTask?.catch(() => undefined);
      await delivery.close();
      conversation.steer = null;
      if (!signal.aborted) {
        await this.completeMessages(
          runtime,
          conversation,
          conversation.groupedIds,
        ).catch(() => undefined);
      }
    }
  }
}
