// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErrorHistoryButton } from "@/components/errors/ErrorHistoryButton";
import { ErrorHost } from "@/components/errors/ErrorHost";
import { clearErrors, errorStore, reportError } from "@/lib/errors";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/controls/dialog";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ writeClipboardText: mocks.copy }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  clearErrors();
  mocks.copy.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function button(text: string) {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-error-host] button"),
  ).find((item) => item.textContent === text);
  if (!match) throw new Error(`missing button: ${text}`);
  return match;
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}
async function mount() {
  await act(async () => {
    root.render(
      <>
        <ErrorHistoryButton />
        <ErrorHost />
      </>,
    );
    reportError("failed", { error: new Error("diagnostic") });
  });
}

it("自动收起后仍能打开历史、展开详情并复制", async () => {
  await mount();
  await advance(8000);
  expect(document.querySelector("[data-error-host]")).toBeNull();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>("[data-error-history-button]")
      ?.click(),
  );
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[data-error-host] button[aria-label="failed"]',
      )
      ?.click(),
  );
  expect(
    document.querySelector("[data-error-host] pre")?.textContent,
  ).toContain("diagnostic");
  await act(async () => button("errors.copy").click());
  expect(mocks.copy).toHaveBeenCalledWith(
    expect.stringContaining("diagnostic"),
  );
  expect(button("errors.copied")).toBeDefined();
});

it("展开详情及窗口失焦暂停计时，恢复后只使用剩余时间", async () => {
  await mount();
  await advance(2000);
  await act(async () => button("errors.details").click());
  await advance(12000);
  expect(errorStore.getState().reports[0].visible).toBe(true);
  await act(async () => button("errors.hideDetails").click());
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await act(async () => window.dispatchEvent(new Event("blur")));
  await advance(12000);
  expect(errorStore.getState().reports[0].visible).toBe(true);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("focus")));
  await advance(5999);
  expect(errorStore.getState().reports[0].visible).toBe(true);
  await advance(1);
  expect(errorStore.getState().reports[0].visible).toBe(false);
});

it("复制失败在当前卡片反馈，不产生递归错误通知", async () => {
  await mount();
  mocks.copy.mockRejectedValueOnce(new Error("clipboard failed"));
  await act(async () => button("errors.copy").click());
  expect(button("errors.copyFailed")).toBeDefined();
  expect(errorStore.getState().reports).toHaveLength(1);
  expect(errorStore.getState().reports[0].visible).toBe(true);
});

it("悬停暂停计时，选中文字不关闭，点击摘要只收起提示", async () => {
  await mount();
  const card = document.querySelector<HTMLElement>("[data-error-host] section");
  if (!card) throw new Error("缺少错误卡片");
  await act(async () =>
    card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
  );
  await advance(10000);
  expect(errorStore.getState().reports[0].visible).toBe(true);
  await act(async () =>
    card.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
  );
  const summary = card.querySelector<HTMLButtonElement>("button");
  if (!summary) throw new Error("缺少错误摘要");
  const range = document.createRange();
  range.selectNodeContents(summary);
  window.getSelection()?.addRange(range);
  await act(async () => summary.click());
  expect(errorStore.getState().reports[0].visible).toBe(true);
  window.getSelection()?.removeAllRanges();
  await act(async () => summary.click());
  expect(errorStore.getState().reports[0].visible).toBe(false);
  expect(errorStore.getState().reports).toHaveLength(1);
});

it("标题栏图标仅在有错误时显示，清空同时移除列表与图标", async () => {
  await act(async () =>
    root.render(
      <>
        <header>
          <ErrorHistoryButton />
        </header>
        <ErrorHost />
      </>,
    ),
  );
  expect(container.querySelector("[data-error-history-button]")).toBeNull();
  await act(async () => reportError("failed"));
  const trigger = container.querySelector<HTMLButtonElement>(
    "header [data-error-history-button]",
  );
  expect(trigger).not.toBeNull();
  expect(
    document.querySelector("[data-error-host] [data-error-history-button]"),
  ).toBeNull();
  await act(async () => trigger?.click());
  await act(async () => button("errors.clear").click());
  expect(errorStore.getState().reports).toHaveLength(0);
  expect(errorStore.getState().historyOpen).toBe(false);
  expect(container.querySelector("[data-error-history-button]")).toBeNull();
  expect(document.querySelector("[data-error-host] aside")).toBeNull();
});

it("错误节点进入模态框焦点范围且不重建详情，关闭弹窗后回到窗口", async () => {
  const changed = vi.fn();
  const render = (open: boolean) =>
    root.render(
      <>
        <ErrorHost />
        <Dialog open={open} onOpenChange={changed}>
          <DialogContent>
            <DialogTitle>settings</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );
  await act(async () => {
    render(false);
    reportError("failed");
  });
  await act(async () => button("errors.details").click());
  const details = document.querySelector("[data-error-host] pre");
  await act(async () => render(true));
  await act(async () => {
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  });
  expect(document.querySelector('[role="dialog"] [data-error-host] pre')).toBe(
    details,
  );
  await act(async () => {
    button("errors.copy").focus();
    button("errors.copy").click();
  });
  expect(changed).not.toHaveBeenCalled();
  expect(mocks.copy).toHaveBeenCalledOnce();
  await act(async () => render(false));
  expect(document.querySelector("body > [data-error-host] pre")).toBe(details);
});

it("页内弹窗的祖先隐藏或禁用后释放错误浮层，重新显示时恢复归属", async () => {
  const render = (hidden: boolean) =>
    root.render(
      <>
        <ErrorHost />
        <div aria-hidden={hidden} inert={hidden}>
          <div role="dialog" aria-label="settings" />
        </div>
      </>,
    );
  await act(async () => {
    render(false);
    reportError("failed");
  });
  await act(async () => button("errors.details").click());
  const details = document.querySelector("[data-error-host] pre");
  expect(document.querySelector('[role="dialog"] [data-error-host] pre')).toBe(
    details,
  );
  await act(async () => render(true));
  expect(document.querySelector("body > [data-error-host] pre")).toBe(details);
  await act(async () => render(false));
  expect(document.querySelector('[role="dialog"] [data-error-host] pre')).toBe(
    details,
  );
});
