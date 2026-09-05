/**
 * 本文件管理多连接的独立接收任务与有界消息队列。
 * 首版 Agent 全局串行，连接轮转取消息；接收身份先落盘，异常退出不重放有副作用的任务。
 */

import {
  type ChannelAdapter,
  type ChannelCheckpoint,
  type ChannelConnection,
  ChannelError,
  type ChannelInbound,
  type ChannelSnapshot,
} from "@/modules/channels/types";

type Dependencies = {
  adapter: (connection: ChannelConnection) => Promise<ChannelAdapter>;
  run: (
    connection: ChannelConnection,
    message: ChannelInbound,
    signal: AbortSignal,
  ) => Promise<string>;
  load: (id: string) => Promise<ChannelCheckpoint>;
  save: (id: string, checkpoint: ChannelCheckpoint) => Promise<void>;
  failureText: () => string;
  changed: (snapshots: ChannelSnapshot[]) => void;
};

type Runtime = {
  snapshot: ChannelSnapshot;
  abort: AbortController;
  queue: ChannelInbound[];
  checkpoint: ChannelCheckpoint;
  writes: Promise<void>;
  receiver: Promise<void>;
  active: Promise<void> | null;
  adapter: ChannelAdapter | null;
  wake: (() => void) | null;
};

/** 管理实例生命周期，不依赖 React、窗口可见性或具体平台协议。 */
export class ChannelManager {
  private readonly runtimes = new Map<string, Runtime>();
  private pumping = false;
  private lastServed: string | null = null;

  constructor(private readonly deps: Dependencies) {}

  /** 只重启配置发生变化的实例，调用方串行调用以保持启停顺序。 */
  async configure(connections: readonly ChannelConnection[]): Promise<void> {
    for (const [id, runtime] of this.runtimes) {
      const next = connections.find((connection) => connection.id === id);
      if (
        !next ||
        JSON.stringify(next) !== JSON.stringify(runtime.snapshot.connection)
      ) {
        await this.stop(runtime);
        this.runtimes.delete(id);
      }
    }
    for (const connection of connections) {
      if (this.runtimes.has(connection.id)) continue;
      const runtime: Runtime = {
        snapshot: {
          connection,
          status: connection.enabled ? "connecting" : "disabled",
          issue: null,
          queued: 0,
          busy: false,
        },
        abort: new AbortController(),
        queue: [],
        checkpoint: {
          cursor: "",
          cursorScope: "",
          recentIds: [],
          pendingIds: [],
        },
        writes: Promise.resolve(),
        receiver: Promise.resolve(),
        active: null,
        adapter: null,
        wake: null,
      };
      this.runtimes.set(connection.id, runtime);
      if (connection.enabled) runtime.receiver = this.receive(runtime);
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

  private async stop(runtime: Runtime): Promise<void> {
    runtime.abort.abort();
    runtime.wake?.();
    runtime.queue = [];
    await Promise.allSettled([
      runtime.receiver,
      runtime.active,
      runtime.writes,
    ]);
  }

  private publish() {
    this.deps.changed(
      [...this.runtimes.values()].map((runtime) => ({
        ...runtime.snapshot,
        queued: runtime.queue.length,
      })),
    );
  }

  /** 检查点失效后停止该实例，保留磁盘上的未完成身份，其他连接仍可调度。 */
  private failStorage(runtime: Runtime): void {
    runtime.snapshot.status = "error";
    runtime.snapshot.issue = "storage";
    runtime.abort.abort();
    runtime.wake?.();
    runtime.queue = [];
    this.publish();
  }

  /** 快照在提交时复制，慢写入不会读到稍后变化的队列身份。 */
  private persist(runtime: Runtime): Promise<void> {
    const checkpoint = structuredClone(runtime.checkpoint);
    const writing = runtime.writes
      .then(() => this.deps.save(runtime.snapshot.connection.id, checkpoint))
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
      runtime.checkpoint = await this.deps.load(connection.id);
      signal.throwIfAborted();
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
        receive: async (message) => {
          signal.throwIfAborted();
          if (runtime.checkpoint.recentIds.includes(message.id)) return;
          while (runtime.checkpoint.pendingIds.length >= 16) {
            runtime.snapshot.issue = "queue-full";
            this.publish();
            await new Promise<void>((resolve) => {
              runtime.wake = resolve;
            });
            runtime.wake = null;
            signal.throwIfAborted();
          }
          runtime.checkpoint.recentIds = [
            ...runtime.checkpoint.recentIds,
            message.id,
          ].slice(-256);
          runtime.checkpoint.pendingIds.push(message.id);
          await this.persist(runtime);
          signal.throwIfAborted();
          runtime.queue.push(message);
          this.publish();
          void this.pump();
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

  /** 连接轮转而非一个连接排空，后续提高并发只需改变此处调度。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const runtimes = [...this.runtimes.values()];
        const previous = runtimes.findIndex(
          (runtime) => runtime.snapshot.connection.id === this.lastServed,
        );
        const ordered = [
          ...runtimes.slice(previous + 1),
          ...runtimes.slice(0, previous + 1),
        ];
        const runtime = ordered.find(
          (candidate) =>
            !candidate.abort.signal.aborted &&
            candidate.adapter &&
            candidate.queue.length,
        );
        if (!runtime) break;
        const message = runtime.queue.shift();
        if (!message) continue;
        this.lastServed = runtime.snapshot.connection.id;
        runtime.snapshot.busy = true;
        this.publish();
        runtime.active = this.execute(runtime, message);
        await runtime.active;
        runtime.active = null;
        runtime.snapshot.busy = false;
        this.publish();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(
    runtime: Runtime,
    message: ChannelInbound,
  ): Promise<void> {
    const signal = runtime.abort.signal;
    let delivering = false;
    try {
      const text = await this.deps.run(
        runtime.snapshot.connection,
        message,
        signal,
      );
      signal.throwIfAborted();
      delivering = true;
      await runtime.adapter?.send(message, text, signal);
      runtime.snapshot.issue = null;
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof ChannelError && error.issue === "storage") {
          this.failStorage(runtime);
          return;
        }
        runtime.snapshot.issue =
          error instanceof ChannelError ? error.issue : "agent";
        if (!delivering) {
          try {
            await runtime.adapter?.send(
              message,
              this.deps.failureText(),
              signal,
            );
          } catch {
            if (!signal.aborted) runtime.snapshot.issue = "delivery";
          }
        }
      }
    } finally {
      if (!signal.aborted) {
        runtime.checkpoint.pendingIds = runtime.checkpoint.pendingIds.filter(
          (id) => id !== message.id,
        );
        runtime.wake?.();
        await this.persist(runtime).catch(() => undefined);
      }
    }
  }
}
