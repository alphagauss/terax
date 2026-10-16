// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n, { preloadEn } from "@/i18n";
import { ChatDisplayContext } from "@/modules/ai/hooks/chatDisplay";
import { native, type ShellProcessInfo } from "@/modules/ai/lib/native";
import {
  ExecutionProcesses,
  SessionProcessesProvider,
} from "./SessionProcesses";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  await preloadEn();
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

it("shares native process status by execution, pauses hidden reads, and observes actual exits", async () => {
  const list = vi
    .spyOn(native, "shellList")
    .mockResolvedValue([
      {
        process_id: "p",
        command: "server",
        execution_id: "run-1",
        task_id: "abcd",
      } as ShellProcessInfo,
    ]);
  const render = (active: boolean) =>
    root.render(
      <ChatDisplayContext.Provider value={active}>
        <SessionProcessesProvider sessionId="session">
          <div id="first">
            <ExecutionProcesses runId="run-1" />
          </div>
          <div id="second">
            <ExecutionProcesses runId="run-2" />
          </div>
        </SessionProcessesProvider>
      </ChatDisplayContext.Provider>,
    );
  await act(async () => render(true));
  expect(container.querySelector("#first")?.textContent).toContain(
    "1 background process",
  );
  expect(container.querySelector("#second")?.textContent).toBe("");
  expect(list).toHaveBeenCalledOnce();
  await act(async () => render(false));
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(list).toHaveBeenCalledOnce();
  list.mockResolvedValue([]);
  await act(async () => render(true));
  expect(container.textContent).not.toContain("background process");
  expect(list).toHaveBeenCalledTimes(2);
});

it("does not publish a late result into a different chat", async () => {
  let finish!: (value: ShellProcessInfo[]) => void;
  vi.spyOn(native, "shellList").mockImplementation((sessionId) =>
    sessionId === "old"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve([]),
  );
  await act(async () =>
    root.render(
      <SessionProcessesProvider sessionId="old">Old</SessionProcessesProvider>,
    ),
  );
  await act(async () =>
    root.render(
      <SessionProcessesProvider sessionId="new">New</SessionProcessesProvider>,
    ),
  );
  await act(async () =>
    finish([{ process_id: "p", command: "old-server" } as ShellProcessInfo]),
  );
  expect(container.textContent).toBe("New");
});
