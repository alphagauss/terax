// @vitest-environment happy-dom

import { Button } from "@/components/controls/button";
import {
  Hint,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeEach(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

const tooltip = () => document.querySelector('[role="tooltip"]');
const wait = async (ms: number) =>
  act(async () => vi.advanceTimersByTimeAsync(ms));
const hover = async (element: Element) =>
  act(async () => {
    element.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }),
    );
  });
const dismiss = async () =>
  act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

it("waits 800ms, skips the delay within 500ms, then restores it", async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Hint content="First">
          <button type="button">A</button>
        </Hint>
        <Hint content="Second">
          <button type="button">B</button>
        </Hint>
        <Hint content="Third">
          <button type="button">C</button>
        </Hint>
      </TooltipProvider>,
    ),
  );
  const [first, second, third] = container.querySelectorAll("button");
  await hover(first);
  await wait(799);
  expect(tooltip()).toBeNull();
  await wait(1);
  expect(tooltip()?.textContent).toBe("First");
  await dismiss();
  await wait(499);
  await hover(second);
  expect(tooltip()?.textContent).toBe("Second");
  await dismiss();
  await wait(501);
  await hover(third);
  expect(tooltip()).toBeNull();
  await wait(800);
  expect(tooltip()?.textContent).toBe("Third");
  expect(container.querySelector("[title]")).toBeNull();
});

it("keeps separate groups independent and supports keyboard focus", async () => {
  await act(async () =>
    root.render(
      <>
        <TooltipProvider>
          <Hint content="One">
            <button type="button">A</button>
          </Hint>
        </TooltipProvider>
        <TooltipProvider>
          <Hint content="Two">
            <button type="button">B</button>
          </Hint>
        </TooltipProvider>
      </>,
    ),
  );
  const [first, second] = container.querySelectorAll("button");
  await act(async () => first.focus());
  expect(tooltip()?.textContent).toBe("One");
  await act(async () => first.blur());
  expect(tooltip()).toBeNull();
  await hover(second);
  expect(tooltip()).toBeNull();
  await wait(800);
  expect(tooltip()?.textContent).toBe("Two");
});

it("dismisses tooltips while the window is inactive and ignores restored focus", async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Hint content="Actions">
          <button type="button">Menu</button>
        </Hint>
      </TooltipProvider>,
    ),
  );
  const button = container.querySelector("button") as HTMLButtonElement;

  await act(async () => button.focus());
  expect(tooltip()?.textContent).toBe("Actions");

  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(tooltip()).toBeNull();

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  expect(tooltip()).toBeNull();

  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    button.blur();
    button.focus();
  });
  expect(tooltip()?.textContent).toBe("Actions");

  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(tooltip()).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });

  await wait(501);
  await hover(button);
  expect(tooltip()).toBeNull();
  await wait(800);
  expect(tooltip()?.textContent).toBe("Actions");
});

it("notifies controlled tooltips when the window becomes inactive", async () => {
  const onOpenChange = vi.fn();
  function ControlledTooltip() {
    const [open, setOpen] = useState(true);
    const handleOpenChange = (next: boolean) => {
      onOpenChange(next);
      setOpen(next);
    };
    return (
      <Tooltip open={open} onOpenChange={handleOpenChange}>
        <TooltipTrigger asChild>
          <button type="button">Metrics</button>
        </TooltipTrigger>
        <TooltipContent>Details</TooltipContent>
      </Tooltip>
    );
  }
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ControlledTooltip />
      </TooltipProvider>,
    ),
  );
  expect(tooltip()?.textContent).toBe("Details");

  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(tooltip()).toBeNull();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("preserves refs and menu clicks through an asChild trigger", async () => {
  const ref = createRef<HTMLButtonElement>();
  const clicked = vi.fn();
  await act(async () =>
    root.render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Hint content="Actions">
            <Button ref={ref} onClick={clicked}>
              Menu
            </Button>
          </Hint>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    ),
  );
  expect(ref.current).toBe(container.querySelector("button"));
  await act(async () => {
    ref.current?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }),
    );
    ref.current?.click();
  });
  expect(clicked).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe(
    "Action",
  );
});

it("shows disabled button explanations without enabling their action", async () => {
  const clicked = vi.fn();
  await act(async () =>
    root.render(
      <Hint content="Unavailable">
        <Button disabled onClick={clicked}>
          Disabled
        </Button>
      </Hint>,
    ),
  );
  const button = container.querySelector("button") as HTMLButtonElement;
  await hover(button);
  await wait(800);
  expect(tooltip()?.textContent).toBe("Unavailable");
  await act(async () => button.click());
  expect(clicked).not.toHaveBeenCalled();
  expect(button.disabled).toBe(true);
});
