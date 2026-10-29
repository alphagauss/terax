/**
 * 本文件测试文件传输冲突决策和 Direct 失败项操作。
 * 锁定对话框只能提交后端声明的动作，并确保文件级重试复用原聚合任务 ID。
 */

// @vitest-environment happy-dom

import {
  act,
  createElement,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransferConflict, TransferTask } from "@/modules/transfers/types";

const mocks = vi.hoisted(() => ({
  tasks: {} as Record<string, TransferTask>,
  resolveConflict: vi.fn(() => Promise.resolve()),
  retryFailure: vi.fn(() => Promise.resolve()),
  ignoreFailure: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/controls/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement("button", { type: "button", ...props }, children),
}));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    createElement("input", {
      ...props,
      type: "checkbox",
      checked: Boolean(checked),
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.currentTarget.checked),
    }),
}));
vi.mock("@/components/controls/alert-dialog", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => children;
  const Action = ({
    children,
    variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) =>
    createElement(
      "button",
      { type: "button", "data-variant": variant, ...props },
      children,
    );
  const Footer = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) =>
    createElement("div", props, children);
  return {
    AlertDialog: Wrapper,
    AlertDialogAction: Action,
    AlertDialogCancel: Action,
    AlertDialogContent: Wrapper,
    AlertDialogDescription: Wrapper,
    AlertDialogFooter: Footer,
    AlertDialogHeader: Wrapper,
    AlertDialogTitle: Wrapper,
  };
});
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => children,
  PopoverContent: ({ children }: { children?: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) =>
    createElement("div", { role: "progressbar", "aria-valuenow": value }),
}));
vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => createElement("svg", { "data-slot": "spinner" }),
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/modules/transfers/native", () => ({
  transferNative: {
    resolveConflict: mocks.resolveConflict,
    retryFailure: mocks.retryFailure,
    ignoreFailure: mocks.ignoreFailure,
  },
}));
vi.mock("@/modules/transfers/store", () => ({
  useTransferBridge: vi.fn(),
  useTransferStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({
      tasks: mocks.tasks,
      panelOpen: false,
      setPanelOpen: vi.fn(),
      removeLocal: vi.fn(),
      removeLocalMany: vi.fn(),
    }),
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string } }) => unknown,
  ) => select({ env: { kind: "wsl" } }),
}));

vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/errors", () => ({ reportError: vi.fn() }));

import {
  TransferConflictDialog,
  TransferStatusControl,
  TransferTaskRow,
} from "@/modules/transfers/TransferStatusControl";

afterEach(() => {
  mocks.tasks = {};
  mocks.resolveConflict.mockClear();
  mocks.retryFailure.mockClear();
  mocks.ignoreFailure.mockClear();
  document.body.innerHTML = "";
});

describe("transfer phase feedback", () => {
  const task: TransferTask = {
    id: "archive-task",
    direction: "upload",
    strategy: "archive",
    status: "running",
    stage: "transferring",
    sourceCount: 1,
    destination: "/target",
    name: "folder",
    totalBytes: 100,
    transferredBytes: 50,
    totalFiles: 10,
    completedFiles: 0,
    failedFiles: 0,
    unprocessedFiles: 0,
    totalRoots: 1,
    committedRoots: 0,
    speedBytesPerSecond: 10,
    currentFile: null,
    failure: null,
    fileFailures: [],
    conflict: null,
    isDirectory: true,
    createdAt: 1,
    updatedAt: 2,
  };

  it("任务排队、失败和续传时保持创建顺序", () => {
    mocks.tasks = {
      old: { ...task, id: "old", name: "old-task", createdAt: 1 },
      newer: { ...task, id: "newer", name: "new-task", createdAt: 2 },
    };
    const view = render(createElement(TransferStatusControl));
    for (const status of [
      "queued",
      "failed",
      "running",
      "completed",
    ] as const) {
      mocks.tasks = {
        ...mocks.tasks,
        newer: { ...mocks.tasks.newer, status, updatedAt: 100 },
      };
      act(() => view.root.render(createElement(TransferStatusControl)));
      const text = view.container.textContent ?? "";
      expect(text.indexOf("new-task")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("new-task")).toBeLessThan(text.indexOf("old-task"));
    }
    act(() => view.root.unmount());
  });

  it.each([
    ["transferring", "transfers.finishingTransfer"],
    ["verifying", "transfers.verifyingAndExtracting"],
    ["extracting", "transfers.stage.extracting"],
    ["finalizing", "transfers.stage.finalizing"],
  ] as const)(
    "replaces full byte progress with live %s feedback",
    (stage, label) => {
      const view = render(
        createElement(TransferTaskRow, {
          task: { ...task, stage, transferredBytes: 100 },
        }),
      );
      expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
      expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
        label,
      );
      expect(
        view.container.querySelector('[data-slot="spinner"]'),
      ).not.toBeNull();
      expect(view.container.textContent).not.toContain("/s");
      if (stage === "finalizing") {
        expect(
          view.container.querySelector('button[aria-label="transfers.pause"]'),
        ).toBeNull();
      }
      act(() => view.root.unmount());
    },
  );

  it("keeps byte progress during transfer and a full bar only on completion", () => {
    const view = render(createElement(TransferTaskRow, { task }));
    expect(
      view.container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("50");
    expect(view.container.textContent).toContain("10 B/s");
    act(() =>
      view.root.render(
        createElement(TransferTaskRow, {
          task: {
            ...task,
            status: "completed",
            stage: "finished",
            transferredBytes: 100,
          },
        }),
      ),
    );
    expect(
      view.container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("100");
    expect(view.container.querySelector('[data-slot="spinner"]')).toBeNull();
    act(() => view.root.unmount());
  });

  it("does not animate a paused finalization", () => {
    const view = render(
      createElement(TransferTaskRow, {
        task: {
          ...task,
          status: "paused",
          stage: "finalizing",
          transferredBytes: 100,
        },
      }),
    );
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      "transfers.status.paused",
    );
    expect(view.container.querySelector('[data-slot="spinner"]')).toBeNull();
    act(() => view.root.unmount());
  });

  it("shows the current phase in the collapsed status bar", () => {
    mocks.tasks = {
      task: { ...task, stage: "finalizing", transferredBytes: 100 },
    };
    const view = render(createElement(TransferStatusControl));
    const trigger = view.container.querySelector(
      'button[aria-label="transfers.title"]',
    );
    expect(trigger?.textContent).toContain("transfers.stage.finalizing");
    expect(trigger?.textContent).not.toContain("transfers.activeSummary");
    act(() => view.root.unmount());
  });
});

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

describe("transfer conflict dialog", () => {
  it("renders only declared decisions and submits skip-all authorization", () => {
    const conflict: TransferConflict = {
      id: "conflict",
      kind: "file",
      sourceKind: "file",
      destinationKind: "file",
      sourcePath: "/source/file",
      destinationPath: "/target/file",
      decisions: ["cancel", "skip", "replace"],
      allowApplyToRemaining: true,
    };
    const { container, root } = render(
      createElement(TransferConflictDialog, { taskId: "task", conflict }),
    );
    const checkbox = container.querySelector<HTMLInputElement>(
      "#transfer-conflict-apply",
    );
    const buttons = Array.from(container.querySelectorAll("button"));

    expect(buttons.map((button) => button.textContent)).toEqual([
      "transfers.conflict.actions.cancel",
      "transfers.conflict.actions.skip",
      "transfers.conflict.actions.replace",
    ]);
    expect(buttons.slice(1).map((button) => button.dataset.variant)).toEqual([
      "default",
      "destructive",
    ]);
    act(() => checkbox?.click());
    act(() => buttons[1]?.click());

    expect(mocks.resolveConflict).toHaveBeenCalledWith({
      taskId: "task",
      conflictId: "conflict",
      decision: "skip",
      applyToRemaining: true,
    });
    act(() => root.unmount());
  });

  it("offers both source-first and destination-first Archive merges", () => {
    const conflict: TransferConflict = {
      id: "archive-conflict",
      kind: "archive_directory",
      sourceKind: "directory",
      destinationKind: "directory",
      sourcePath: "/source/folder",
      destinationPath: "/target/folder",
      decisions: ["cancel", "replace_directory", "merge", "merge_skip"],
      allowApplyToRemaining: false,
    };
    const { container, root } = render(
      createElement(TransferConflictDialog, { taskId: "task", conflict }),
    );
    const buttons = Array.from(container.querySelectorAll("button"));

    expect(buttons.map((button) => button.textContent)).toEqual([
      "transfers.conflict.actions.cancel",
      "transfers.conflict.actions.replace_directory",
      "transfers.conflict.actions.merge",
      "transfers.conflict.actions.merge_skip",
    ]);
    expect(container.querySelector(".grid-cols-2")).not.toBeNull();
    expect(buttons.every((button) => button.className.includes("w-full"))).toBe(
      true,
    );
    expect(buttons.slice(1).map((button) => button.dataset.variant)).toEqual([
      "destructive",
      "secondary",
      "default",
    ]);
    act(() => buttons[3]?.click());
    expect(mocks.resolveConflict).toHaveBeenCalledWith({
      taskId: "task",
      conflictId: "archive-conflict",
      decision: "merge_skip",
      applyToRemaining: false,
    });
    act(() => root.unmount());
  });
});

describe("Direct failure actions", () => {
  it("routes retry and ignore through the original aggregate task", () => {
    const task: TransferTask = {
      id: "task",
      direction: "upload",
      strategy: "direct",
      status: "completed_with_errors",
      stage: "finished",
      sourceCount: 1,
      destination: "/target",
      name: "folder",
      totalBytes: 10,
      transferredBytes: 0,
      totalFiles: 1,
      completedFiles: 0,
      failedFiles: 1,
      unprocessedFiles: 0,
      totalRoots: 1,
      committedRoots: 1,
      speedBytesPerSecond: 0,
      currentFile: null,
      failure: null,
      fileFailures: [
        {
          id: "failure",
          sourcePath: "/source/file",
          destinationPath: "/target/file",
          failure: {
            code: "source_changed",
            detail: "changed",
            retryable: true,
          },
          attempts: 1,
          ignored: false,
        },
      ],
      conflict: null,
      isDirectory: true,
      createdAt: 1,
      updatedAt: 2,
    };
    const { container, root } = render(
      createElement(TransferTaskRow, { task }),
    );
    const expand = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "transfers.failedFiles",
    );
    act(() => expand?.click());
    const retry = container.querySelector<HTMLButtonElement>(
      'button[aria-label="transfers.retryFile"]',
    );
    act(() => retry?.click());

    expect(mocks.retryFailure).toHaveBeenCalledWith("task", "failure");
    act(() => root.unmount());

    const ignored = render(createElement(TransferTaskRow, { task }));
    const ignoredExpand = Array.from(
      ignored.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "transfers.failedFiles");
    act(() => ignoredExpand?.click());
    const remove = ignored.container.querySelector<HTMLButtonElement>(
      'button[aria-label="transfers.removeFailure"]',
    );
    act(() => remove?.click());

    expect(mocks.ignoreFailure).toHaveBeenCalledWith("task", "failure");
    act(() => ignored.root.unmount());
  });
});
