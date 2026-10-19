// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { preloadEn } from "@/i18n";
import {
  FileEditContext,
  FileEditStats,
} from "@/modules/ai/components/FileEditStats";
import { ChatActivityBlock } from "@/modules/ai/components/ChatActivityBlock";
import { FileEditsCard } from "@/modules/ai/components/FileEditsCard";
import { SubagentCard } from "@/modules/ai/components/SubagentCard";
import {
  getFileEditRuntime,
  releaseFileEditRuntime,
} from "@/modules/ai/lib/fileEditRuntime";
import { useChatStore } from "@/modules/ai/store/chatStore";

vi.mock("@/modules/editor/ReadonlyDiffLazy", () => ({
  ReadonlyDiff: ({ before, after }: { before: string; after: string }) => (
    <div data-testid="diff">
      {before}
      {after}
    </div>
  ),
}));
let root: Root;
let container: HTMLDivElement;
const sessionId = "edit-ui";
const context = { sessionId };
const file = {
  path: "a.ts",
  identity: "/a.ts",
  before: "old\n",
  after: "new\nextra\n",
  isNewFile: false,
};

function firstButton(): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!button) throw new Error("Missing button");
  return button;
}

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  await preloadEn();
  await i18n.changeLanguage("en");
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  releaseFileEditRuntime(sessionId);
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  document.body.replaceChildren();
});

describe("文件改动展示", async () => {
  it("新一轮复用调用 ID 时，历史工具仍显示自己的最终统计", async () => {
    const calls = [{ toolCallId: "edit", added: 2, removed: 1 }];
    act(() =>
      root.render(
        <FileEditContext.Provider value={{ sessionId, calls }}>
          <FileEditStats toolCallId="edit" />
          <FileEditStats toolCallId="failed" />
        </FileEditContext.Provider>,
      ),
    );
    const runtime = getFileEditRuntime(sessionId);
    await act(async () => {
      runtime.input("edit", undefined, "write_file", undefined, {
        content: "one\ntwo\nthree\n",
      });
      runtime.input("failed", undefined, "write_file", undefined, {
        content: "new turn\n",
      });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.textContent).toBe("+2-1");
    expect(container.querySelector(".file-edit-number-motion")).toBeNull();
  });

  it("数字跟随展示中的工具标题，展开后转到工具行，活动结束不残留", async () => {
    const runtime = getFileEditRuntime(sessionId);
    await runtime.complete("edit", undefined, [file]);
    const render = (key: string, running = true) =>
      act(() =>
        root.render(
          <FileEditContext.Provider value={context}>
            <ChatActivityBlock
              sessionId={sessionId}
              activityKey="file-edits"
              running={running}
              headline={{ kind: "tool", key, text: key }}
            >
              <FileEditStats toolCallId="edit" />
            </ChatActivityBlock>
          </FileEditContext.Provider>,
        ),
      );
    render("edit");
    const trigger = () => firstButton();
    expect(trigger().textContent).toContain("+2-1");
    expect(container.querySelector('[data-direction="up"]')).not.toBeNull();
    expect(container.querySelector('[data-direction="down"]')).not.toBeNull();
    act(() => trigger().click());
    expect(trigger().textContent).not.toContain("+2");
    expect(container.querySelectorAll(".file-edit-number")).toHaveLength(2);
    act(() => trigger().click());
    render("shell");
    expect(trigger().textContent).toContain("+2-1");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(trigger().textContent).toBe("shell");
    render("shell", false);
    expect(trigger().textContent).not.toContain("+2");
    act(() => trigger().click());
    expect(container.textContent).toContain("+2-1");
  });

  it("Subagent 卡片和展开过程使用同一调用统计，完成标题不保留数字", async () => {
    const runtime = getFileEditRuntime(sessionId);
    await runtime.complete("edit", "task", [file]);
    const part = {
      type: "tool-run_subagent" as const,
      toolCallId: "spawn",
      state: "output-available" as const,
      input: { task: "Edit" },
      output: { task_id: "task", status: "running" },
    };
    const display = {
      taskId: "task",
      toolCallId: "spawn",
      label: "Worker",
      status: "running" as const,
      phase: "tool" as const,
      startedAt: 0,
      steps: [
        {
          id: "edit",
          toolName: "apply_patch",
          summary: ["a.ts"],
          status: "running" as const,
        },
      ],
    };
    act(() =>
      root.render(
        <FileEditContext.Provider value={context}>
          <SubagentCard part={part} display={display} />
        </FileEditContext.Provider>,
      ),
    );
    const trigger = firstButton();
    expect(trigger.textContent).toContain("+2-1");
    act(() => trigger.click());
    expect(trigger.textContent).not.toContain("+2");
    expect(container.textContent).toContain("+2-1");
    act(() =>
      root.render(
        <FileEditContext.Provider value={context}>
          <SubagentCard
            part={part}
            display={{
              ...display,
              status: "completed",
              steps: [{ ...display.steps[0], status: "completed" }],
            }}
          />
        </FileEditContext.Provider>,
      ),
    );
    expect(trigger.textContent).not.toContain("+2");
  });

  it("卡片按统一悬停延迟挂载历史 Diff，点击传递整轮而非单个文件", async () => {
    const runtime = getFileEditRuntime(sessionId);
    await runtime.complete(
      "edit",
      undefined,
      Array.from({ length: 5 }, (_, index) => ({
        ...file,
        identity: `/${index}.ts`,
        path: `${index}.ts`,
      })),
    );
    const edits = { ...runtime.snapshot(), turnId: "turn" };
    releaseFileEditRuntime(sessionId);
    const openFileEdits = vi.fn();
    useChatStore.setState({
      live: { ...useChatStore.getState().live, openFileEdits },
    });
    act(() =>
      root.render(<FileEditsCard sessionId={sessionId} edits={edits} />),
    );
    expect(container.textContent).toContain("Show 2 more files");
    expect(container.querySelectorAll(".file-edit-number-motion")).toHaveLength(
      0,
    );
    const first = firstButton();
    act(() =>
      first.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
        }),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(799));
    expect(document.querySelector('[data-testid="diff"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(
      document.querySelector('[data-testid="diff"]')?.textContent,
    ).toContain("old\nnew\nextra");
    const preview = document.querySelector('[data-slot="tooltip-content"]');
    expect(preview?.className).toContain("flex-col");
    expect(preview?.className).toContain("items-stretch");
    act(() => first.click());
    expect(openFileEdits).toHaveBeenCalledWith({
      sessionId,
      edits,
      selectedIdentity: "/0.ts",
    });
  });
});
