// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

function Example({ showCloseButton = true }: { showCloseButton?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={showCloseButton}
        closeButtonClassName="top-0.5 right-1"
      >
        <DialogTitle>Example</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

it("提示组合保留关闭按钮的自定义定位、关闭行为和可访问名称", async () => {
  await act(async () => root.render(<Example />));
  const close = document.querySelector<HTMLButtonElement>(
    '[role="dialog"] button[aria-label="close"]',
  );
  expect(close).not.toBeNull();
  expect(close?.classList.contains("top-0.5")).toBe(true);
  expect(close?.classList.contains("right-1")).toBe(true);
  expect(close?.classList.contains("top-2")).toBe(false);
  expect(close?.classList.contains("right-3")).toBe(false);
  await act(async () => close?.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("调用方可以隐藏关闭图标", async () => {
  await act(async () => root.render(<Example showCloseButton={false} />));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"] button')).toBeNull();
});
