// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/controls/tooltip";
import { TransferStatusControl } from "@/modules/transfers/TransferStatusControl";
import { useTransferStore } from "@/modules/transfers/store";
import type { TransferTask } from "@/modules/transfers/types";

vi.mock("@/modules/transfers/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/transfers/store")>()),
  useTransferBridge: vi.fn(),
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string } }) => unknown,
  ) => select({ env: { kind: "ssh" } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const completed: TransferTask = {
  id: "completed",
  direction: "upload",
  strategy: "direct",
  status: "completed",
  stage: "finished",
  sourceCount: 1,
  destination: "/target",
  name: "file",
  totalBytes: 100,
  transferredBytes: 100,
  totalFiles: 1,
  completedFiles: 1,
  failedFiles: 0,
  unprocessedFiles: 0,
  totalRoots: 1,
  committedRoots: 1,
  elapsedMs: null,
  speedBytesPerSecond: 0,
  currentFile: null,
  failure: null,
  fileFailures: [],
  conflict: null,
  isDirectory: false,
  createdAt: 1,
  updatedAt: 2,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
const wait = () => act(async () => vi.advanceTimersByTimeAsync(0));
const clearButton = () =>
  document.querySelector<HTMLButtonElement>(
    'button[aria-label="transfers.clearCompleted"]',
  ) as HTMLButtonElement;
const entrance = () =>
  container.querySelector<HTMLButtonElement>(
    'button[aria-label="transfers.title"]',
  ) as HTMLButtonElement;

beforeEach(async () => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useTransferStore.setState({
    tasks: { completed },
    panelOpen: false,
    pendingPanelTaskIds: {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <input aria-label="Editor" />
        <TransferStatusControl />
      </TooltipProvider>,
    ),
  );
  await act(async () => container.querySelector("input")?.focus());
});

afterEach(async () => {
  await act(async () => root.unmount());
  await wait();
  container.remove();
  vi.useRealTimers();
  environment.IS_REACT_ACT_ENVIRONMENT = false;
});

it("preserves the editor focus when a background transfer opens and closes the panel", async () => {
  const editor = container.querySelector("input") as HTMLInputElement;
  await act(async () =>
    entrance().dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () =>
    useTransferStore.getState().requestPanelForTask(completed.id),
  );
  await wait();
  expect(clearButton()).not.toBeNull();
  expect(document.activeElement).toBe(editor);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => useTransferStore.getState().setPanelOpen(false));
  await wait();
  expect(document.activeElement).toBe(editor);
});

it("keeps manual opening and focus restoration without showing hints", async () => {
  await act(async () => entrance().click());
  await wait();
  expect(document.activeElement).toBe(clearButton());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await wait();
  expect(document.activeElement).toBe(entrance());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  // 主动打开过一次，也不能让下一次后台展示沿用旧的焦点策略。
  const editor = container.querySelector("input") as HTMLInputElement;
  await act(async () => editor.focus());
  await act(async () =>
    useTransferStore.getState().requestPanelForTask(completed.id),
  );
  await wait();
  expect(document.activeElement).toBe(editor);
});

it("restores focus after the user enters an automatically opened panel", async () => {
  await act(async () =>
    useTransferStore.getState().requestPanelForTask(completed.id),
  );
  await wait();
  await act(async () => clearButton().focus());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => useTransferStore.getState().setPanelOpen(false));
  await wait();
  expect(document.activeElement).toBe(entrance());
});
