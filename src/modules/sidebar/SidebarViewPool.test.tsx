// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarViewPool } from "./SidebarViewPool";
import type { SidebarPlacements, SidebarRuntimeState } from "./types";

const placements: SidebarPlacements = {
  primary: ["explorer", "source-control"],
  secondary: [],
};

function runtime(activeId: "explorer" | "source-control"): SidebarRuntimeState {
  return {
    version: 1,
    primary: { activeId, collapsed: false, width: 280 },
    secondary: { activeId: null, collapsed: true, width: 320 },
    secondaryMode: "normal",
  };
}

let rootElement: HTMLDivElement;
let primaryHost: HTMLDivElement;
let secondaryHost: HTMLDivElement;

beforeEach(() => {
  rootElement = document.createElement("div");
  primaryHost = document.createElement("div");
  primaryHost.dataset.sidebarViewHost = "primary";
  secondaryHost = document.createElement("div");
  secondaryHost.dataset.sidebarViewHost = "secondary";
  document.body.append(rootElement, primaryHost, secondaryHost);
});

afterEach(() => {
  rootElement.remove();
  primaryHost.remove();
  secondaryHost.remove();
});

it("keeps activated views in their real host across ordinary switches", async () => {
  const root = createRoot(rootElement);
  const views = [
    { id: "explorer" as const, content: <div data-content="explorer" /> },
    {
      id: "source-control" as const,
      content: <div data-content="source-control" />,
    },
  ];

  try {
    await act(async () => {
      root.render(
        <SidebarViewPool
          views={views}
          placements={placements}
          runtime={runtime("explorer")}
          temporarilyHidden={false}
        />,
      );
    });

    const explorer = primaryHost.querySelector<HTMLElement>(
      '[data-sidebar-view="explorer"]',
    );
    expect(explorer).not.toBeNull();
    expect(explorer?.style.visibility).toBe("visible");

    await act(async () => {
      root.render(
        <SidebarViewPool
          views={views}
          placements={placements}
          runtime={runtime("source-control")}
          temporarilyHidden={false}
        />,
      );
    });

    expect(explorer?.parentElement).toBe(primaryHost);
    expect(explorer?.style.visibility).toBe("hidden");
    expect(
      primaryHost.querySelector('[data-sidebar-view="source-control"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(
        <SidebarViewPool
          views={views}
          placements={placements}
          runtime={runtime("explorer")}
          temporarilyHidden={false}
        />,
      );
    });

    expect(primaryHost.querySelector('[data-sidebar-view="explorer"]')).toBe(
      explorer,
    );
    expect(explorer?.style.visibility).toBe("visible");
  } finally {
    await act(async () => root.unmount());
  }
});

it("moves an activated view only when its sidebar location changes", async () => {
  const root = createRoot(rootElement);
  const views = [
    { id: "explorer" as const, content: <div data-content="explorer" /> },
  ];

  try {
    await act(async () => {
      root.render(
        <SidebarViewPool
          views={views}
          placements={{ primary: ["explorer"], secondary: [] }}
          runtime={runtime("explorer")}
          temporarilyHidden={false}
        />,
      );
    });

    const explorer = primaryHost.querySelector<HTMLElement>(
      '[data-sidebar-view="explorer"]',
    );
    expect(explorer).not.toBeNull();

    await act(async () => {
      root.render(
        <SidebarViewPool
          views={views}
          placements={{ primary: [], secondary: ["explorer"] }}
          runtime={{
            ...runtime("explorer"),
            primary: { activeId: null, collapsed: true, width: 280 },
            secondary: {
              activeId: "explorer",
              collapsed: false,
              width: 320,
            },
          }}
          temporarilyHidden={false}
        />,
      );
    });

    expect(explorer?.parentElement).toBe(secondaryHost);
    expect(secondaryHost.querySelector('[data-sidebar-view="explorer"]')).toBe(
      explorer,
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("保留未缩放的有效尺寸，隐藏不接受零宽，恢复接入宿主新尺寸", async () => {
  const root = createRoot(rootElement);
  let size = { width: 280, height: 600 };
  vi.spyOn(primaryHost, "clientWidth", "get").mockImplementation(
    () => size.width,
  );
  vi.spyOn(primaryHost, "clientHeight", "get").mockImplementation(
    () => size.height,
  );
  vi.spyOn(primaryHost, "getBoundingClientRect").mockImplementation(
    () => ({ width: size.width * 1.5, height: size.height * 1.5 }) as DOMRect,
  );
  const render = (collapsed: boolean, temporarilyHidden = false) =>
    act(async () =>
      root.render(
        <SidebarViewPool
          views={[{ id: "explorer", content: <input defaultValue="draft" /> }]}
          placements={placements}
          runtime={{
            ...runtime("explorer"),
            primary: { ...runtime("explorer").primary, collapsed },
          }}
          temporarilyHidden={temporarilyHidden}
        />,
      ),
    );
  try {
    await render(false);
    const view = primaryHost.querySelector<HTMLElement>(
      '[data-sidebar-view="explorer"]',
    );
    if (!view) throw new Error("Missing sidebar view");
    const input = view.querySelector("input");
    expect([view.style.width, view.style.height]).toEqual(["280px", "600px"]);
    size = { width: 0, height: 600 };
    await render(true);
    expect([view.style.width, view.style.height]).toEqual(["280px", "600px"]);
    expect(view.inert).toBe(true);
    size = { width: 340, height: 720 };
    await render(false, true);
    expect([view.style.width, view.style.height]).toEqual(["280px", "600px"]);
    await render(false);
    expect([view.style.width, view.style.height]).toEqual(["340px", "720px"]);
    expect(view.querySelector("input")).toBe(input);
    expect(view.inert).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  }
});
