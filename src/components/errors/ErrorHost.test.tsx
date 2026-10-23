// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErrorHistoryButton } from "@/components/errors/ErrorHistoryButton";
import { ErrorHost } from "@/components/errors/ErrorHost";
import { PageContextMenu } from "@/components/menu/PageContextMenu";
import {
  clearErrors,
  dismissError,
  errorStore,
  ignoreError,
  reportError,
  setErrorHistoryOpen,
} from "@/lib/errors";
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
let restoreAnimations: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  clearErrors();
  mocks.copy.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreAnimations?.();
  restoreAnimations = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-error-host] button"),
  ).find(
    (item) =>
      item.textContent === text || item.getAttribute("aria-label") === text,
  );
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

function enableAnimations() {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  const animations: {
    element: HTMLElement;
    frames: Keyframe[];
    animation: Animation;
  }[] = [];
  const animate = vi.fn(function (
    this: HTMLElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const animation = {
      playState: "running",
      onfinish: null,
      oncancel: null,
      cancel: vi.fn(() => clearTimeout(timer)),
    } as unknown as Animation;
    const timer = setTimeout(() => {
      Object.defineProperty(animation, "playState", { value: "finished" });
      animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
    }, Number(options.duration));
    animations.push({ element: this, frames, animation });
    return animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  restoreAnimations = () => {
    if (original)
      Object.defineProperty(HTMLElement.prototype, "animate", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  };
  return { animate, animations };
}

it("自动收起后仍能打开历史、展开详情并复制", async () => {
  enableAnimations();
  await mount();
  await advance(8000);
  expect(errorStore.getState().reports[0].visible).toBe(false);
  expect(
    document.querySelector("[data-error-host] aside[inert]"),
  ).not.toBeNull();
  await advance(160);
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

it("清空立即移除记录和入口，完整历史画面禁用交互并在退场结束后移除", async () => {
  enableAnimations();
  await mount();
  await advance(240);
  await act(async () => setErrorHistoryOpen(true));
  await advance(240);
  await act(async () => button("errors.details").click());
  const details = document.querySelector("[data-error-host] pre");
  const header = document.querySelector('[data-error-motion="history"]');
  await act(async () => button("errors.clear").click());
  expect(errorStore.getState().reports).toHaveLength(0);
  expect(errorStore.getState().historyOpen).toBe(false);
  expect(container.querySelector("[data-error-history-button]")).toBeNull();
  expect(document.querySelector("[data-error-host] pre")).toBe(details);
  expect(document.querySelector('[data-error-motion="history"]')).toBe(header);
  expect(details?.closest("aside[inert][aria-hidden=true]")).not.toBeNull();
  await advance(159);
  expect(document.querySelector("[data-error-host] pre")).toBe(details);
  await advance(1);
  expect(document.querySelector("[data-error-host]")).toBeNull();
});

it("单条忽略保留退出画面，其他卡片以位移补位且不重建详情", async () => {
  const { animations } = enableAnimations();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const siblings = Array.from(this.parentElement?.children ?? []).filter(
        (item) => (item as HTMLElement).style.position !== "absolute",
      );
      const top = this.dataset.errorMotion
        ? this.style.position === "absolute"
          ? Number.parseFloat(this.style.top) || 0
          : siblings.indexOf(this) * 100
        : 0;
      return new DOMRect(0, top, 380, this.dataset.errorMotion ? 100 : 200);
    },
  );
  await mount();
  await advance(240);
  await act(async () => button("errors.details").click());
  const details = document.querySelector("[data-error-host] pre");
  let id = "";
  await act(async () => {
    id = reportError("other");
  });
  await advance(240);
  const outgoing = document.querySelector(`[data-error-motion="${id}"]`);
  await act(async () => setErrorHistoryOpen(true));
  await advance(240);
  await act(async () => ignoreError(id));
  expect(errorStore.getState().reports.some((item) => item.id === id)).toBe(
    false,
  );
  expect(outgoing?.hasAttribute("inert")).toBe(true);
  expect(document.querySelector("[data-error-host] pre")).toBe(details);
  expect(
    [...animations].reverse().find(({ element }) => element.contains(details))
      ?.frames,
  ).toEqual([
    { opacity: "1", transform: "translateY(100px)" },
    { opacity: "1", transform: "none" },
  ]);
  await advance(160);
  expect(outgoing?.isConnected).toBe(false);
  expect(
    document.querySelector('[data-error-motion="history"]'),
  ).not.toBeNull();
  expect(document.querySelector("[data-error-host] pre")).toBe(details);
  expect(
    document.querySelector("[data-error-host] [style*='position: absolute']"),
  ).toBeNull();
});

it("快速反向展开从当前透明度和位置继续，旧退场不会卸载重新打开的历史", async () => {
  const { animations } = enableAnimations();
  await mount();
  await advance(240);
  await act(async () => dismissError(errorStore.getState().reports[0].id));
  await advance(160);
  await act(async () => setErrorHistoryOpen(true));
  await advance(240);
  await act(async () => button("errors.details").click());
  const details = document.querySelector("[data-error-host] pre");
  const surface = document.querySelector("[data-error-host] aside");
  await act(async () => button("close").click());
  const closing = animations[animations.length - 1]?.animation;
  await advance(60);
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element === surface
      ? ({
          opacity: "0.45",
          transform: "matrix(1, 0, 0, 1, 0, -4)",
        } as CSSStyleDeclaration)
      : getStyle(element),
  );
  await act(async () => setErrorHistoryOpen(true));
  expect(closing?.cancel).toHaveBeenCalledOnce();
  expect(animations[animations.length - 1]?.frames[0]).toEqual({
    opacity: "0.45",
    transform: "matrix(1, 0, 0, 1, 0, -4)",
  });
  expect(document.querySelector("[data-error-host] pre")).toBe(details);
  expect(surface?.hasAttribute("inert")).toBe(false);
  await advance(240);
  expect(document.querySelector("[data-error-host] pre")).toBe(details);
});

it("清空退场期间的新错误正常展示，旧记录不会因旧动画完成而恢复", async () => {
  enableAnimations();
  await mount();
  await advance(240);
  const old = errorStore.getState().reports[0].id;
  await act(async () => clearErrors());
  await advance(60);
  await act(async () => reportError("new failure"));
  await advance(240);
  expect(document.querySelector(`[data-error-motion="${old}"]`)).toBeNull();
  expect(
    document.querySelector("[data-error-host] aside")?.hasAttribute("inert"),
  ).toBe(false);
  expect(errorStore.getState().reports).toHaveLength(1);
  expect(document.querySelector("[data-error-host]")?.textContent).toContain(
    "new failure",
  );
});

it("清空打断单条退场时保留当前透明度，再随整体一起退出", async () => {
  enableAnimations();
  await mount();
  await advance(240);
  const old = errorStore.getState().reports[0].id;
  await act(async () => reportError("other"));
  await advance(240);
  await act(async () => dismissError(old));
  const outgoing = document.querySelector<HTMLElement>(
    `[data-error-motion="${old}"]`,
  );
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element === outgoing
      ? ({ opacity: "0.4" } as CSSStyleDeclaration)
      : getStyle(element),
  );
  await act(async () => clearErrors());
  expect(outgoing?.style.opacity).toBe("0.4");
  await advance(160);
  expect(document.querySelector("[data-error-host]")).toBeNull();
});

it("减少动态效果时立即清空，过渡中启用时结束动画并释放宿主", async () => {
  const { animate, animations } = enableAnimations();
  const media = Object.assign(new EventTarget(), {
    matches: false,
  }) as MediaQueryList;
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  await mount();
  await advance(240);
  await act(async () => clearErrors());
  Object.defineProperty(media, "matches", { value: true, configurable: true });
  await act(async () => media.dispatchEvent(new Event("change")));
  expect(document.querySelector("[data-error-host]")).toBeNull();
  expect(
    animations[animations.length - 1]?.animation.cancel,
  ).toHaveBeenCalledOnce();
  animate.mockClear();
  await act(async () => reportError("reduced"));
  await act(async () => clearErrors());
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector("[data-error-host]")).toBeNull();
});

it("卸载时取消退场动画并移除减少动态效果监听", async () => {
  const { animations } = enableAnimations();
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const remove = vi.spyOn(media, "removeEventListener");
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  await mount();
  await advance(240);
  await act(async () => clearErrors());
  const closing = animations[animations.length - 1]?.animation;
  await act(async () => root.render(null));
  expect(closing?.cancel).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  expect(document.querySelector("[data-error-host]")).toBeNull();
});

it.each(["历史", "单条"] as const)(
  "%s 退场的透明终态保持到退出节点移除后才释放",
  async (mode) => {
    const { animations } = enableAnimations();
    await mount();
    await advance(240);
    const id = errorStore.getState().reports[0].id;
    if (mode === "历史") {
      await act(async () => dismissError(id));
      await advance(160);
      await act(async () => setErrorHistoryOpen(true));
      await advance(240);
    }
    if (mode === "单条") {
      await act(async () => reportError("other"));
      await advance(240);
    }
    const outgoing = document.querySelector<HTMLElement>(
      mode === "单条"
        ? `[data-error-motion="${id}"]`
        : "[data-error-host] aside",
    );
    const start = animations.length;
    await act(async () => {
      if (mode === "单条") dismissError(id);
      else button("close").click();
    });
    const closing = animations
      .slice(start)
      .find(({ element }) => element === outgoing);
    if (!closing) throw new Error("缺少退出动画");
    const cancel = vi.mocked(closing.animation.cancel);
    const cleanup = cancel.getMockImplementation();
    const connectedAtRelease: boolean[] = [];
    cancel.mockImplementation(() => {
      connectedAtRelease.push(!!outgoing?.isConnected);
      cleanup?.();
    });
    await advance(160);
    expect(connectedAtRelease).toEqual([false]);
  },
);

it("退场完成与新错误同批提交时，旧清理不取消新入场动画", async () => {
  const { animations } = enableAnimations();
  await mount();
  await advance(240);
  await act(async () => clearErrors());
  await act(async () => {
    vi.advanceTimersByTime(160);
    reportError("new failure");
  });
  const entering = animations[animations.length - 1].animation;
  expect(entering.cancel).not.toHaveBeenCalled();
  expect(document.querySelector("[data-error-host]")?.textContent).toContain(
    "new failure",
  );
  await advance(240);
  expect(entering.cancel).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-error-host]")?.textContent).toContain(
    "new failure",
  );
});

it("临时提醒的关闭保留历史，忽略移除记录并在最后一条退出后隐藏入口", async () => {
  enableAnimations();
  await mount();
  await advance(240);
  await act(async () => button("close").click());
  expect(errorStore.getState().reports).toHaveLength(1);
  await advance(160);
  await act(async () => setErrorHistoryOpen(true));
  await advance(240);
  await act(async () => button("errors.ignore").click());
  expect(errorStore.getState().reports).toHaveLength(0);
  expect(
    document.querySelector("[data-error-host] aside[inert]"),
  ).not.toBeNull();
  await advance(160);
  expect(document.querySelector("[data-error-host]")).toBeNull();
  expect(container.querySelector("[data-error-history-button]")).toBeNull();
  await act(async () => reportError("new error"));
  await advance(240);
  const actions = button("close").parentElement;
  expect(actions?.lastElementChild).toBe(button("errors.ignore"));
  await act(async () => button("errors.ignore").click());
  expect(errorStore.getState().reports).toHaveLength(0);
});

it.each(["pointer", "focus", "escape", "blur"])(
  "历史通过 %s 外部交互收起，内部操作和入口切换不误关",
  async (kind) => {
    await mount();
    await act(async () => setErrorHistoryOpen(true));
    await act(async () =>
      button("errors.copy").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      ),
    );
    expect(errorStore.getState().historyOpen).toBe(true);
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      await act(async () => {
        if (kind === "pointer")
          outside.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true }),
          );
        if (kind === "focus")
          outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        if (kind === "escape")
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
        if (kind === "blur") window.dispatchEvent(new Event("blur"));
      });
      expect(errorStore.getState().historyOpen).toBe(false);
      expect(errorStore.getState().reports[0].visible).toBe(false);
      await act(async () => {
        const trigger = container.querySelector<HTMLButtonElement>(
          "[data-error-history-button]",
        );
        trigger?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true }),
        );
        trigger?.click();
      });
      expect(errorStore.getState().historyOpen).toBe(true);
    } finally {
      outside.remove();
    }
  },
);

it("详情保留摘要和操作行，展开与收起都播放局部揭示且文字不改变", async () => {
  const { animations } = enableAnimations();
  await mount();
  await advance(240);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const height = this.style.height
        ? Number.parseFloat(this.style.height)
        : this.querySelector("pre")
          ? 160
          : 0;
      return new DOMRect(0, 0, 380, height);
    },
  );
  const toggle = button("errors.details");
  const actions = toggle.parentElement;
  const preview = document.querySelector("[data-error-preview]");
  const start = animations.length;
  await act(async () => toggle.click());
  expect(toggle.textContent).toBe("errors.details");
  expect(toggle.parentElement).toBe(actions);
  expect(document.querySelector("[data-error-preview]")).toBe(preview);
  expect(preview).not.toBeNull();
  expect(animations.length).toBeGreaterThan(start);
  await advance(160);
  const opened = animations.length;
  const detail = document.querySelector("[data-error-host] pre");
  await act(async () => toggle.click());
  expect(detail?.closest("[inert]")).not.toBeNull();
  expect(animations.length).toBeGreaterThan(opened);
  await advance(160);
  expect(document.querySelector("[data-error-host] pre")).toBeNull();
});

it("历史中的右键菜单在浮层内获得焦点，Escape 只关闭菜单", async () => {
  await mount();
  await act(async () =>
    root.render(
      <>
        <ErrorHistoryButton />
        <ErrorHost />
        <PageContextMenu />
      </>,
    ),
  );
  await act(async () => setErrorHistoryOpen(true));
  const host = document.querySelector<HTMLElement>("[data-error-host]");
  if (!host) throw new Error("缺少错误浮层");
  const link = document.createElement("a");
  link.href = "https://example.com";
  link.textContent = "diagnostic link";
  host.append(link);
  await act(async () => {
    link.focus();
    link.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      }),
    );
  });
  const menu = host.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  expect(errorStore.getState().historyOpen).toBe(true);
  await act(async () =>
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await advance(0);
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(errorStore.getState().historyOpen).toBe(true);
});
