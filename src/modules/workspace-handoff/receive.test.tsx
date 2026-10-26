// @vitest-environment happy-dom
/** 系统路径请求等待恢复完成，消费期间的重渲染和新通知不会并行处理目录。 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceOpenPaths, WorkspaceRuntimeMessage } from "./index";

const mocks = vi.hoisted(() => ({
  messages: [] as WorkspaceRuntimeMessage[],
  notify: () => {},
  invoke: vi.fn(),
  listen: vi.fn(),
  show: vi.fn(async () => {}),
  focus: vi.fn(async () => {}),
  success: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({ isPrimary: true }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: mocks.show, setFocus: mocks.focus }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("sonner", () => ({ toast: { success: mocks.success } }));
import { useWorkspacePageHandoff } from "./index";

const root = createRoot(document.createElement("div"));
const getTab = () => undefined;
const openPage = vi.fn();
function Harness({
  ready,
  openPaths,
}: {
  ready: boolean;
  openPaths: (paths: WorkspaceOpenPaths) => Promise<void>;
}) {
  useWorkspacePageHandoff({
    ready,
    openPaths,
    getTab,
    openPage,
    windowMode: "multiple",
  });
  return null;
}
afterEach(async () => act(async () => root.unmount()));

it("waits for hydration and keeps queued requests serial across callback and language changes", async () => {
  mocks.invoke.mockImplementation(async () => mocks.messages.splice(0));
  mocks.listen.mockImplementation(async (_event, callback) => {
    mocks.notify = callback;
    return () => {};
  });
  let finish = () => {};
  const first = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const second = vi.fn(async () => {});
  const cold: WorkspaceOpenPaths = {
    kind: "openPaths",
    directories: ["/project", "/other"],
    files: ["/file.rs"],
  };
  mocks.messages.push(cold);
  await act(async () =>
    root.render(createElement(Harness, { ready: false, openPaths: first })),
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
  await act(async () =>
    root.render(createElement(Harness, { ready: true, openPaths: first })),
  );
  expect(first).toHaveBeenCalledExactlyOnceWith(cold);

  mocks.t = (key: string) => `zh:${key}`;
  await act(async () =>
    root.render(createElement(Harness, { ready: true, openPaths: second })),
  );
  const warm: WorkspaceOpenPaths = {
    kind: "openPaths",
    directories: ["/project"],
    files: ["/second.rs"],
  };
  const page = { kind: "web-preview" as const, url: "https://example.com" };
  mocks.messages.push(warm, { kind: "copyPage", page });
  await act(async () => mocks.notify());
  expect(mocks.listen).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(second).toHaveBeenCalledExactlyOnceWith(warm);
  expect(openPage).toHaveBeenCalledExactlyOnceWith(page);
  expect(mocks.success).toHaveBeenCalledExactlyOnceWith(
    "zh:windowCopyReceived",
  );
  expect(mocks.messages).toEqual([]);
});
