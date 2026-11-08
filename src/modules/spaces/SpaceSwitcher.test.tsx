// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { useSpaces } from "./lib/useSpaces";

it("opens with focus away from the enabled bulk close button", async () => {
  const previous = useSpaces.getState();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const headingRef = createRef<HTMLSpanElement>();
  useSpaces.getState().hydrate([], "default");

  try {
    await act(async () => {
      root.render(
        <SpaceSwitcher
          open
          onOpenChange={vi.fn()}
          tabs={[
            { id: 1, kind: "terminal", spaceId: "default", title: "Shell" },
          ]}
          headingRef={headingRef}
          checkingAllTabs={false}
          confirmingCloseAllTabs={false}
          onCloseAllTabs={vi.fn()}
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

    const bulkButton = document.querySelector<HTMLButtonElement>(
      '[data-slot="popover-content"] button[data-variant="ghost-destructive-hover"]',
    );
    expect(bulkButton?.disabled).toBe(false);
    expect(document.activeElement).toBe(headingRef.current);
  } finally {
    act(() => root.unmount());
    host.remove();
    useSpaces.setState(previous, true);
  }
});
