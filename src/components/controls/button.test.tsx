// @vitest-environment happy-dom

import { Button } from "@/components/controls/button";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("普通菜单触发器默认弱化，打开和悬停反馈由公共控件提供，取值状态不自动增加选中外观", async () => {
  await act(async () =>
    root.render(
      <Button variant="ghost" size="xs" aria-expanded aria-pressed>
        <svg aria-hidden />
        <span>Category</span>
      </Button>,
    ),
  );
  const button = container.querySelector("button");
  expect(button?.classList.contains("text-muted-foreground")).toBe(true);
  expect(button?.classList.contains("hover:text-foreground")).toBe(true);
  expect(button?.classList.contains("aria-expanded:text-foreground")).toBe(
    true,
  );
  expect(button?.classList.contains("aria-expanded:bg-muted")).toBe(true);
  expect(button?.getAttribute("aria-pressed")).toBe("true");
  expect(button?.className).not.toContain("aria-pressed:");
  expect(button?.querySelector("svg")?.getAttribute("class")).toBeNull();
});

it.each([
  [
    "ghost-warning",
    "text-amber-600",
    "hover:text-amber-700",
    "aria-expanded:text-amber-600",
  ],
  [
    "ghost-destructive",
    "text-destructive",
    "hover:text-destructive",
    "aria-expanded:text-destructive",
  ],
  [
    "ghost-destructive-hover",
    "text-muted-foreground",
    "hover:text-destructive",
    "aria-expanded:text-destructive",
  ],
] as const)(
  "%s 的语义色不会被基础 ghost 的悬停及打开颜色覆盖",
  async (variant, normal, hover, expanded) => {
    await act(async () =>
      root.render(
        <Button variant={variant} aria-expanded>
          Action
        </Button>,
      ),
    );
    const button = container.querySelector("button");
    for (const token of [
      normal,
      hover,
      expanded,
      "hover:bg-muted",
      "aria-expanded:bg-muted",
    ])
      expect(button?.classList.contains(token)).toBe(true);
    expect(button?.classList.contains("hover:text-foreground")).toBe(false);
    expect(button?.classList.contains("aria-expanded:text-foreground")).toBe(
      false,
    );
    if (variant === "ghost-warning") {
      expect(button?.classList.contains("dark:text-amber-400")).toBe(true);
      expect(button?.classList.contains("dark:hover:text-amber-300")).toBe(
        true,
      );
      expect(
        button?.classList.contains("dark:aria-expanded:text-amber-400"),
      ).toBe(true);
    }
  },
);

it("主按钮和有底色的危险按钮保留原有语义，业务可以覆盖专用外观", async () => {
  await act(async () =>
    root.render(
      <>
        <Button>Submit</Button>
        <Button variant="destructive">Delete</Button>
        <Button
          variant="ghost"
          className="text-primary hover:text-primary max-w-32"
        >
          Custom
        </Button>
      </>,
    ),
  );
  const [primary, danger, custom] = container.querySelectorAll("button");
  expect(primary.classList.contains("text-primary-foreground")).toBe(true);
  expect(primary.classList.contains("text-muted-foreground")).toBe(false);
  expect(danger.classList.contains("bg-destructive/10")).toBe(true);
  expect(danger.classList.contains("text-destructive")).toBe(true);
  expect(custom.classList.contains("text-primary")).toBe(true);
  expect(custom.classList.contains("hover:text-primary")).toBe(true);
  expect(custom.classList.contains("text-muted-foreground")).toBe(false);
});

it("禁用的语义按钮不会执行操作", async () => {
  const click = vi.fn();
  await act(async () =>
    root.render(
      <Button variant="ghost-warning" disabled onClick={click}>
        Permission
      </Button>,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(click).not.toHaveBeenCalled();
});
