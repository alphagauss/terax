// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActivePath } from "./ActivePath";

const mocks = vi.hoisted(() => ({ copy: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: mocks.copy }));

vi.mock("@/lib/errors", () => ({ reportError: mocks.error }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function copyFromMenu() {
  const trigger = container.querySelector<HTMLElement>(
    "[data-slot='context-menu-trigger']",
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
    );
  });
  const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
  expect(items).toHaveLength(1);
  expect(items[0].textContent).toBe("path.copyFullPath");
  await act(async () => items[0].click());
}

it("切换文件和终端时只读展示并复制完整路径，无路径时清空", async () => {
  for (const [path, file] of [
    ["D:/project/目录 with spaces/src/App.tsx", true],
    ["/home/user/project", false],
    ["C:\\project\\file.ts", true],
    ["/", false],
  ] as const) {
    await act(async () => root.render(<ActivePath path={path} file={file} />));
    expect(container.textContent).toBe(path);
    expect(container.querySelector("a, button")).toBeNull();
    await act(async () => container.querySelector<HTMLElement>("bdi")?.click());
    expect(mocks.copy).not.toHaveBeenCalled();
    await copyFromMenu();
    expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(path);
    mocks.copy.mockClear();
  }
  await act(async () => root.render(<ActivePath path={null} />));
  expect(container.textContent).toBe("");
  expect(
    container.querySelector("[data-slot='context-menu-trigger']"),
  ).toBeNull();
});

it("复制失败时提示错误", async () => {
  mocks.copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await act(async () => root.render(<ActivePath path="/project" />));
  await copyFromMenu();
  expect(mocks.error).toHaveBeenCalledWith("common:pageMenu.copyFailed", {
    error: expect.objectContaining({ message: "clipboard unavailable" }),
  });
});
