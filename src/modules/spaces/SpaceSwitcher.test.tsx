// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { useSpaces } from "./lib/useSpaces";

it("keeps all Spaces collapsed across reopening until manually expanded", async () => {
  const previous = useSpaces.getState();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const headingRef = createRef<HTMLSpanElement>();
  useSpaces.getState().hydrate(
    [
      {
        id: "project",
        name: "Project",
        root: null,
        rootLocked: false,
        autoName: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    "default",
  );
  const onCloseAllTabs = vi.fn();
  const onOpenChange = vi.fn();

  const render = (open: boolean) =>
    act(async () => {
      root.render(
        <SpaceSwitcher
          open={open}
          onOpenChange={onOpenChange}
          tabs={[
            { id: 1, kind: "terminal", spaceId: "default", title: "Shell" },
          ]}
          headingRef={headingRef}
          checkingAllTabs={false}
          confirmingCloseAllTabs={false}
          onCloseAllTabs={onCloseAllTabs}
          onNewSpace={vi.fn()}
          onNewSpaceFromDirectory={vi.fn()}
          onToggleRootLock={vi.fn()}
          onDeleteSpace={vi.fn()}
          onNewTabInSpace={vi.fn()}
          onJumpTab={vi.fn()}
          onCloseTab={vi.fn()}
          onMoveTabToSpace={vi.fn()}
          onReorderTab={vi.fn()}
          onReorderSpaces={vi.fn()}
        />,
      );
    });

  try {
    await render(true);

    const bulkButton = document.querySelector<HTMLButtonElement>(
      '[data-slot="popover-content"] button[data-variant="ghost-destructive-hover"]',
    );
    expect(bulkButton?.disabled).toBe(false);
    expect(document.activeElement).toBe(headingRef.current);

    const collapseAll = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse all Spaces"]',
    );
    expect(collapseAll?.nextElementSibling).toBe(bulkButton);

    const toggles = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "[data-space-id] button[aria-expanded][aria-controls]",
        ),
      );
    const expansion = () =>
      toggles().map((button) => button.getAttribute("aria-expanded"));
    expect(expansion()).toEqual(["true", "false"]);
    act(() => toggles()[1].click());
    expect(expansion()).toEqual(["true", "true"]);

    act(() => collapseAll?.click());
    expect(expansion()).toEqual(["false", "false"]);
    expect(collapseAll?.disabled).toBe(false);
    act(() => collapseAll?.click());
    expect(expansion()).toEqual(["false", "false"]);
    expect(onCloseAllTabs).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await render(false);
    await render(true);
    expect(expansion()).toEqual(["false", "false"]);

    act(() => toggles()[1].click());
    expect(expansion()).toEqual(["false", "true"]);
    await render(false);
    await render(true);
    expect(expansion()).toEqual(["false", "true"]);
  } finally {
    act(() => root.unmount());
    host.remove();
    useSpaces.setState(previous, true);
  }
});
