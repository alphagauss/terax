// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "@/components/controls/button";
import { Hint, TooltipProvider } from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
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
