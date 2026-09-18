import {
  computeLineStats,
  summarizeFileEdits,
} from "@/modules/ai/lib/fileEditDiff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEditRuntime } from "@/modules/ai/lib/fileEditRuntime";
import {
  mergeFileEdits,
  type FileEditSegment,
} from "@/modules/ai/lib/fileEdits";

const file = (before: string, after: string): FileEditSegment => ({
  path: "a.ts",
  identity: "/work/a.ts",
  before,
  after,
  isNewFile: false,
});
afterEach(() => vi.useRealTimers());

describe("文件编辑展示事实", async () => {
  it("200ms 内合并预估，最终结果立即取代预估且迟到解析不能覆盖它", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const runtime = new FileEditRuntime(publish);
    runtime.input(
      "write",
      undefined,
      "write_file",
      '{"path":"a.ts","content":"one\\n',
    );
    runtime.input("write", undefined, "write_file", "two\\n");
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.dynamicImportSettled();
    expect(runtime.getCall("write")).toMatchObject({
      added: 2,
      removed: 0,
      approximate: true,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    runtime.input("write", undefined, "write_file", 'three\\n"}');
    vi.advanceTimersByTime(200);
    await runtime.complete("write", undefined, [
      file("one\ntwo\n", "one\nchanged\n"),
    ]);
    await vi.runAllTimersAsync();
    expect(runtime.getCall("write")).toMatchObject({
      added: 1,
      removed: 1,
      approximate: false,
    });
    runtime.input("write", undefined, "write_file", undefined, {
      content: "late\n",
    });
    await vi.runAllTimersAsync();
    expect(runtime.getCall("write")?.removed).toBe(1);
    runtime.dispose();
  });

  it("完整参数在节流窗口结束前立即发布预估", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const runtime = new FileEditRuntime(publish);
    runtime.input(
      "write",
      undefined,
      "write_file",
      '{"path":"a.ts","content":"one\\n',
    );

    runtime.input("write", undefined, "write_file", undefined, {
      path: "a.ts",
      content: "one\ntwo\n",
    });

    expect(runtime.getCall("write")).toMatchObject({
      added: 2,
      removed: 0,
      approximate: true,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("失败会丢弃正在解析的预估，不保存未执行的内容", async () => {
    vi.useFakeTimers();
    const runtime = new FileEditRuntime(() => {});
    runtime.input(
      "patch",
      undefined,
      "apply_patch",
      '{"files":[{"path":"a.ts","edits":[{"old_text":"a\\nb","new_text":"c',
    );
    vi.advanceTimersByTime(200);
    runtime.fail("patch");
    await vi.runAllTimersAsync();
    expect(runtime.getCall("patch")).toBeUndefined();
    expect(runtime.snapshot().calls).toEqual([]);
    runtime.dispose();
  });

  it("主 Agent 与 Subagent 独立记调用，轮末只计同一文件的净改动", async () => {
    const runtime = new FileEditRuntime(() => {});
    await runtime.complete("same", undefined, [file("a\n", "b\n")]);
    await runtime.complete("same", "child", [file("b\n", "a\n")]);
    const snapshot = runtime.snapshot();
    expect(snapshot.calls).toHaveLength(2);
    expect(
      snapshot.calls.every((call) => call.added === 1 && call.removed === 1),
    ).toBe(true);
    expect(snapshot.files).toEqual([file("a\n", "a\n")]);
    expect(summarizeFileEdits(snapshot)).toEqual([]);
  });

  it("checkpoint 保存期间完成的编辑留给下次提交，重试和重放不重复计数", async () => {
    const runtime = new FileEditRuntime(() => {});
    await runtime.complete("first", undefined, [file("a\n", "b\n")]);
    const first = runtime.pending();
    await runtime.complete("second", "child", [file("b\n", "c\n")]);
    expect(first.snapshot.files).toEqual([file("a\n", "b\n")]);
    runtime.acknowledge(first.count);
    const second = runtime.pending();
    expect(second.snapshot.calls.map((call) => call.toolCallId)).toEqual([
      "second",
    ]);
    expect(second.snapshot.files).toEqual([file("b\n", "c\n")]);
    expect(
      mergeFileEdits([first.snapshot, first.snapshot, second.snapshot]),
    ).toEqual(runtime.snapshot());
    runtime.acknowledge(second.count);
    expect(runtime.pending().snapshot.calls).toEqual([]);
    expect(runtime.snapshot().files).toEqual([file("a\n", "c\n")]);
  });

  it("基线不连续时保留两段，不把中间的外部修改计入工具改动", async () => {
    const runtime = new FileEditRuntime(() => {});
    await runtime.complete("first", undefined, [file("a\n", "b\n")]);
    await runtime.complete("second", undefined, [
      file("external\nb\n", "external\nc\n"),
    ]);
    const summary = summarizeFileEdits(runtime.snapshot());
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ added: 2, removed: 2 });
    expect(summary[0].segments).toHaveLength(2);
  });

  it("回滚不确定时保存路径并显示未知，而不是成功的零改动", async () => {
    const runtime = new FileEditRuntime(() => {});
    await runtime.complete("failed", undefined, [], ["a.ts"]);
    expect(runtime.getCall("failed")?.uncertain).toBe(true);
    expect(runtime.snapshot().uncertainPaths).toEqual(["a.ts"]);
  });

  it("子任务结束只清除自己的预估，保留已提交事实和父任务的进度", async () => {
    vi.useFakeTimers();
    const runtime = new FileEditRuntime(() => {});
    runtime.input("pending", "child", "write_file", undefined, {
      content: "unfinished",
    });
    runtime.input("parent", undefined, "write_file", undefined, {
      content: "parent",
    });
    await runtime.complete("done", "child", [file("a\n", "b\n")]);
    await vi.advanceTimersByTimeAsync(200);
    runtime.finishTask("child");
    expect(runtime.getCall("pending", "child")).toBeUndefined();
    expect(runtime.getCall("done", "child")?.approximate).toBe(false);
    expect(runtime.getCall("parent")?.approximate).toBe(true);
    expect(runtime.snapshot().calls).toHaveLength(1);
    runtime.dispose();
  });

  it.each([
    ["", "a\nb\n", 2, 0],
    ["a\r\nb\r\n", "a\r\nc\r\n", 1, 1],
    ["a\nb", "a\nc", 1, 1],
    ["same\n", "same\n", 0, 0],
    [`old ${"x".repeat(200)} old`, `new ${"x".repeat(200)} new`, 1, 1],
    ["same\r\n", "same\n", 0, 0],
  ])("行数统计保留换行语义 %#", (before, after, added, removed) => {
    expect(computeLineStats(before, after)).toEqual({ added, removed });
  });
});
