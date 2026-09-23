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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  await hover(second);
  expect(tooltip()?.textContent).toBe("Second");
  await dismiss();
  await wait(499);
  await act(async () =>
    first.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  await hover(first);
  expect(tooltip()?.textContent).toBe("First");
  await dismiss();
  await wait(501);
  await hover(third);
  expect(tooltip()).toBeNull();
  await wait(800);
  expect(tooltip()?.textContent).toBe("Third");
  expect(container.querySelector("[title]")).toBeNull();
});

it("keeps separate hover groups independent", async () => {
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
  await hover(first);
  await wait(800);
  expect(tooltip()?.textContent).toBe("One");
  await dismiss();
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

  await hover(button);
  await wait(800);
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
  expect(tooltip()).toBeNull();

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

it("keeps focus events observable without opening a tooltip", async () => {
  const focused = vi.fn();
  const blurred = vi.fn();
  await act(async () =>
    root.render(
      <Hint content="Actions">
        <button type="button" onFocus={focused} onBlur={blurred}>
          Action
        </button>
      </Hint>,
    ),
  );
  const button = container.querySelector("button") as HTMLButtonElement;
  await act(async () => button.focus());
  await wait(800);
  expect(focused).toHaveBeenCalledOnce();
  expect(tooltip()).toBeNull();
  await hover(button);
  await wait(800);
  expect(tooltip()).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(tooltip()).toBeNull();
  expect(blurred).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);
});

it("cancels pending hover on window blur and pointer down", async () => {
  await act(async () =>
    root.render(
      <Hint content="Actions">
        <button type="button">Action</button>
      </Hint>,
    ),
  );
  const button = container.querySelector("button") as HTMLButtonElement;
  await hover(button);
  await wait(400);
  await act(async () => window.dispatchEvent(new Event("blur")));
  await wait(800);
  expect(tooltip()).toBeNull();
  await hover(button);
  await wait(799);
  expect(tooltip()).toBeNull();
  await wait(1);
  expect(tooltip()).not.toBeNull();
  await act(async () =>
    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  expect(tooltip()).toBeNull();
  await hover(button);
  await wait(800);
  expect(tooltip()).toBeNull();
  await act(async () =>
    button.dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  await hover(button);
  await wait(400);
  await act(async () =>
    button.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
    ),
  );
  await wait(800);
  expect(tooltip()).toBeNull();
});

it("ignores touch and pen movement", async () => {
  await act(async () =>
    root.render(
      <Hint content="Actions">
        <button type="button">Action</button>
      </Hint>,
    ),
  );
  for (const pointerType of ["touch", "pen"]) {
    await act(async () =>
      container
        .querySelector("button")
        ?.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerType }),
        ),
    );
    await wait(800);
    expect(tooltip()).toBeNull();
  }
});

it("does not show hints for popup autofocus, expanded entrances or restored focus", async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Popover>
          <PopoverTrigger asChild>
            <Hint content="Entrance">
              <button type="button">Open</button>
            </Hint>
          </PopoverTrigger>
          <PopoverContent>
            <Hint content="Clear completed">
              <button type="button">Clear</button>
            </Hint>
          </PopoverContent>
        </Popover>
      </TooltipProvider>,
    ),
  );
  const entrance = container.querySelector("button") as HTMLButtonElement;
  await act(async () => entrance.click());
  await wait(0);
  const action = document.querySelector(
    '[data-slot="popover-content"] button',
  ) as HTMLButtonElement;
  expect(document.activeElement).toBe(action);
  await hover(entrance);
  await wait(800);
  expect(tooltip()).toBeNull();
  await hover(action);
  await wait(800);
  expect(tooltip()?.textContent).toBe("Clear completed");
  await dismiss();
  await dismiss();
  await wait(0);
  expect(document.activeElement).toBe(entrance);
  await wait(800);
  expect(tooltip()).toBeNull();
});
