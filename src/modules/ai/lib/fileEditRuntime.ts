/**
 * 会话拥有的文件编辑展示通道。每 500ms 只发布最新预估，最终事实不经过节流。
 * checkpoint 只追加尚未保存的批次，保存成功后确认；UI 订阅不控制采集生命周期。
 */
import {
  emptyFileEdits,
  estimateFileEdit,
  fileEditCallKey,
  mergeFileEdits,
  type FileEditCall,
  type FileEditSegment,
  type FileEditSnapshot,
} from "@/modules/ai/lib/fileEdits";

type InputState = {
  toolName: string;
  text: string;
  input?: unknown;
  revision: number;
  sampled: number;
  toolCallId: string;
  taskId?: string;
  onInput?: (toolCallId: string, toolName: string, input: unknown) => void;
};
export type LiveFileEdit = FileEditCall & { approximate: boolean };
const runtimes = new Map<string, FileEditRuntime>();
const listeners = new Map<string, Set<() => void>>();
const ESTIMATE_INTERVAL_MS = 500;

function notify(sessionId: string): void {
  for (const listener of listeners.get(sessionId) ?? []) {
    try {
      listener();
    } catch {
      // 展示订阅失败不能改变工具的提交结果或会话解锁。
    }
  }
}

export function getFileEditRuntime(sessionId: string): FileEditRuntime {
  let runtime = runtimes.get(sessionId);
  if (!runtime) {
    runtime = new FileEditRuntime(() => notify(sessionId));
    runtimes.set(sessionId, runtime);
  }
  return runtime;
}

export function peekFileEditRuntime(
  sessionId: string,
): FileEditRuntime | undefined {
  return runtimes.get(sessionId);
}

export function subscribeFileEdits(
  sessionId: string,
  listener: () => void,
): () => void {
  let group = listeners.get(sessionId);
  if (!group) {
    group = new Set();
    listeners.set(sessionId, group);
  }
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(sessionId);
  };
}

/** 终态已保存并物化到消息后释放，保存失败时保留全部事实供重试。 */
export function releaseFileEditRuntime(sessionId: string): void {
  runtimes.get(sessionId)?.dispose();
  runtimes.delete(sessionId);
  notify(sessionId);
}

export class FileEditRuntime {
  private inputs = new Map<string, InputState>();
  private values = new Map<string, LiveFileEdit>();
  private batches: Array<{ snapshot: FileEditSnapshot; count: number }> = [];
  private history = emptyFileEdits();
  private serial = 0;
  private sealed = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private terminalCalls = new Set<string>();
  private executions = new Set<Promise<unknown>>();

  constructor(private readonly publish: () => void) {}

  /** 原生提交不可随流中止而遗失；终态保存等待已开始的文件调用返回。 */
  track<T>(operation: () => Promise<T>): Promise<T> {
    const result = operation();
    this.executions.add(result);
    void result.then(
      () => this.executions.delete(result),
      () => this.executions.delete(result),
    );
    return result;
  }

  async settled(): Promise<void> {
    while (this.executions.size) await Promise.allSettled([...this.executions]);
  }

  getCall(toolCallId: string, taskId?: string): LiveFileEdit | undefined {
    return this.values.get(fileEditCallKey(toolCallId, taskId));
  }

  input(
    toolCallId: string,
    taskId: string | undefined,
    toolName: string,
    delta: string | undefined,
    input?: unknown,
    onInput?: InputState["onInput"],
  ): void {
    if (this.disposed) return;
    const key = fileEditCallKey(toolCallId, taskId);
    if (this.terminalCalls.has(key)) return;
    const state = this.inputs.get(key) ?? {
      toolCallId,
      taskId,
      toolName,
      text: "",
      revision: 0,
      sampled: -1,
    };
    if (delta !== undefined) state.text += delta;
    if (input !== undefined) {
      state.input = input;
      state.text = "";
    }
    state.revision++;
    state.onInput = onInput;
    this.inputs.set(key, state);
    if (input !== undefined) {
      this.publishEstimate(key, state, input);
      this.inputs.delete(key);
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sample();
    }, ESTIMATE_INTERVAL_MS);
  }

  private async sample(): Promise<void> {
    for (const [key, state] of this.inputs) {
      if (state.sampled === state.revision) continue;
      const revision = state.revision;
      const input =
        state.input ??
        (await (await import("ai")).parsePartialJson(state.text)).value;
      if (this.disposed || this.inputs.get(key) !== state) continue;
      state.sampled = revision;
      this.publishEstimate(key, state, input);
      if (state.revision !== revision) this.schedule();
      else if (state.input !== undefined) this.inputs.delete(key);
    }
  }

  /** 完整参数在工具执行前立即发布，避免短调用被节流窗口吞掉。 */
  private publishEstimate(key: string, state: InputState, input: unknown): void {
    state.onInput?.(state.toolCallId, state.toolName, input);
    const stats = estimateFileEdit(state.toolName, input);
    const previous = this.values.get(key);
    if (
      previous &&
      previous.added === stats.added &&
      previous.removed === stats.removed
    )
      return;
    this.values.set(key, {
      toolCallId: state.toolCallId,
      taskId: state.taskId,
      ...stats,
      approximate: true,
    });
    this.publish();
  }

  /** 提交返回后同步记事实，绝不重新读盘采集其他进程的修改。 */
  async complete(
    toolCallId: string,
    taskId: string | undefined,
    files: FileEditSegment[],
    uncertainPaths: string[] = [],
  ): Promise<void> {
    const key = fileEditCallKey(toolCallId, taskId);
    this.inputs.delete(key);
    if (this.terminalCalls.has(key)) return;
    this.terminalCalls.add(key);
    const { computeLineStats } = await import("@/modules/ai/lib/fileEditDiff");
    const stats = files.reduce(
      (total, file) => {
        const diff = computeLineStats(file.before, file.after);
        return {
          added: total.added + diff.added,
          removed: total.removed + diff.removed,
        };
      },
      { added: 0, removed: 0 },
    );
    const call: FileEditCall = {
      toolCallId,
      ...(taskId ? { taskId } : {}),
      ...stats,
      ...(uncertainPaths.length ? { uncertain: true } : {}),
    };
    this.values.set(key, { ...call, approximate: false });
    const snapshot: FileEditSnapshot = {
      kind: "file-edits",
      calls: [call],
      files,
      uncertainPaths,
    };
    const last = this.batches[this.batches.length - 1];
    const count = ++this.serial;
    // 尚未交给持久化的连续修改只保留首尾，保存期间的新结果另开批次。
    if (last && last.count > this.sealed) {
      last.snapshot = mergeFileEdits([last.snapshot, snapshot]);
      last.count = count;
    } else this.batches.push({ snapshot, count });
    this.publish();
  }

  fail(toolCallId: string, taskId?: string): void {
    const key = fileEditCallKey(toolCallId, taskId);
    if (this.terminalCalls.has(key)) return;
    const pending = this.inputs.delete(key);
    const visible = this.values.delete(key);
    if (pending || visible) this.publish();
  }

  pending(): { snapshot: FileEditSnapshot; count: number } {
    this.sealed = this.serial;
    return {
      snapshot: mergeFileEdits(this.batches.map((batch) => batch.snapshot)),
      count: this.serial,
    };
  }

  /** 子任务结束后丢弃未提交的预估，已确认的文件修改继续属于父轮次。 */
  finishTask(taskId: string): void {
    for (const input of this.inputs.values())
      if (input.taskId === taskId) this.fail(input.toolCallId, taskId);
    for (const value of this.values.values())
      if (value.taskId === taskId && value.approximate)
        this.fail(value.toolCallId, taskId);
  }

  acknowledge(count: number): void {
    const saved = this.batches.filter((batch) => batch.count <= count);
    this.history = mergeFileEdits([
      this.history,
      ...saved.map((batch) => batch.snapshot),
    ]);
    this.batches = this.batches.filter((batch) => batch.count > count);
  }
  snapshot(): FileEditSnapshot {
    return mergeFileEdits([
      this.history,
      ...this.batches.map((batch) => batch.snapshot),
    ]);
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.inputs.clear();
  }
}
