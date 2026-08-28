/**
 * 本文件测试 Alpha 面板池的懒加载、错误隔离和稳定挂载行为。
 * 重点锁定宿主替换、隐藏恢复和删除时的 React 实例与 DOM 容器生命周期。
 */

// @vitest-environment happy-dom

import type {
  AlphaPanelInstance,
  AlphaPanelProps,
} from "@/modules/alpha/workstation/model";
import {
  AlphaPanelHost,
  AlphaPanelPool,
} from "@/modules/alpha/workstation/components/AlphaPanelPool";
import {
  createAlphaPanelRegistry,
  type AlphaPanelDescriptor,
  type AlphaPanelRegistry,
} from "@/modules/alpha/workstation/registry";
import { act, createRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function panel(id: string, type = "chart"): AlphaPanelInstance {
  return {
    id,
    type,
    binding: { mode: "follow" },
    config: { interval: "d" },
  };
}

function descriptor(
  type: string,
  load: AlphaPanelDescriptor["load"],
): AlphaPanelDescriptor {
  return {
    type,
    titleKey: `workstation.panels.${type}`,
    category: "market",
    singleton: false,
    pinnable: true,
    defaultSize: { w: 8, h: 8, minW: 4, minH: 4 },
    createDefaultConfig: () => ({}),
    validateConfig: () => ({}),
    load,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("AlphaPanelPool", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  function renderPool(
    panels: readonly AlphaPanelInstance[],
    registry: AlphaPanelRegistry,
    options: {
      visible?: boolean;
      hostKey?: string;
      showHosts?: boolean;
      mainSymbol?: string;
      onPanelConfigChange?: (
        panelId: string,
        config: AlphaPanelInstance["config"],
      ) => void;
    } = {},
  ) {
    root?.render(
      <AlphaPanelPool
        panels={panels}
        registry={registry}
        mainSymbol={options.mainSymbol ?? "000001.SZSE"}
        visible={options.visible ?? true}
        onPanelConfigChange={options.onPanelConfigChange ?? vi.fn()}
      >
        {options.showHosts !== false &&
          panels.map((item) => (
            <AlphaPanelHost
              key={`${item.id}:${options.hostKey ?? "initial"}`}
              panelId={item.id}
            />
          ))}
      </AlphaPanelPool>,
    );
  }

  it("宿主替换和隐藏恢复时保持面板实例与容器", async () => {
    const lifecycle = { mounts: 0, unmounts: 0 };
    const seenProps: AlphaPanelProps[] = [];
    function TestPanel(props: AlphaPanelProps) {
      seenProps.push(props);
      useEffect(() => {
        lifecycle.mounts += 1;
        return () => {
          lifecycle.unmounts += 1;
        };
      }, []);
      return <div data-testid="test-panel">panel</div>;
    }
    const load = vi.fn(async () => ({ default: TestPanel }));
    const registry = createAlphaPanelRegistry([descriptor("chart", load)]);
    const panels = [panel("panel-1")];

    await act(async () => renderPool(panels, registry));
    await flush();
    const firstHost = container.querySelector("[data-alpha-panel-host]");
    const panelContainer = container.querySelector("[data-alpha-panel]");
    const panelElement = container.querySelector("[data-testid='test-panel']");
    expect(firstHost?.contains(panelContainer)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
    expect(seenProps[seenProps.length - 1]?.vtSymbol).toBe("000001.SZSE");

    await act(async () =>
      renderPool(panels, registry, { mainSymbol: "600000.SSE" }),
    );
    expect(seenProps[seenProps.length - 1]?.vtSymbol).toBe("600000.SSE");
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });

    await act(async () =>
      renderPool(panels, registry, { hostKey: "replacement" }),
    );
    const replacementHost = container.querySelector("[data-alpha-panel-host]");
    expect(replacementHost).not.toBe(firstHost);
    expect(container.querySelector("[data-alpha-panel]")).toBe(panelContainer);
    expect(container.querySelector("[data-testid='test-panel']")).toBe(
      panelElement,
    );
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });

    await act(async () => renderPool(panels, registry, { showHosts: false }));
    expect(container.querySelector("[data-alpha-panel-host]")).toBeNull();
    expect(container.querySelector("[data-alpha-panel]")).toBe(panelContainer);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });

    await act(async () =>
      renderPool(panels, registry, { hostKey: "restored" }),
    );
    expect(container.querySelector("[data-alpha-panel]")).toBe(panelContainer);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });

    await act(async () =>
      renderPool(panels, registry, {
        visible: false,
        hostKey: "restored",
      }),
    );
    expect((panelContainer as HTMLElement).style.visibility).toBe("hidden");
    expect(seenProps[seenProps.length - 1]?.visible).toBe(false);
    await act(async () =>
      renderPool(panels, registry, {
        visible: true,
        hostKey: "restored",
      }),
    );
    expect((panelContainer as HTMLElement).style.visibility).toBe("visible");
    expect(seenProps[seenProps.length - 1]?.visible).toBe(true);
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });

    await act(async () => renderPool([], registry));
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 1 });
    expect(panelContainer?.isConnected).toBe(false);
  });

  it("未知类型只在自身容器显示占位状态", async () => {
    const registry = createAlphaPanelRegistry([]);

    await act(async () => renderPool([panel("missing", "future")], registry));

    expect(container.textContent).toContain("workstation.panel.unknown");
    expect(container.querySelector("[role='alert']")).not.toBeNull();
  });

  it("宿主向网格转发 DOM ref、样式、类名和指针事件", async () => {
    const registry = createAlphaPanelRegistry([]);
    const hostRef = createRef<HTMLDivElement>();
    const onMouseDown = vi.fn();

    await act(async () =>
      root?.render(
        <AlphaPanelPool
          panels={[]}
          registry={registry}
          mainSymbol="000001.SZSE"
          visible
          onPanelConfigChange={vi.fn()}
        >
          <AlphaPanelHost
            ref={hostRef}
            panelId="panel-1"
            className="grid-item"
            style={{ width: "120px" }}
            onMouseDown={onMouseDown}
          />
        </AlphaPanelPool>,
      ),
    );

    expect(hostRef.current?.classList.contains("grid-item")).toBe(true);
    expect(hostRef.current?.style.width).toBe("120px");
    act(() => {
      hostRef.current?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });
    expect(onMouseDown).toHaveBeenCalledTimes(1);

    await act(async () => root?.render(null));
    expect(hostRef.current).toBeNull();
  });

  it("面板排序变化时保持每个实例的身份", async () => {
    const mounts = new Map<string, number>();
    function TestPanel({ panelId }: AlphaPanelProps) {
      useEffect(() => {
        mounts.set(panelId, (mounts.get(panelId) ?? 0) + 1);
      }, [panelId]);
      return <div data-panel-content={panelId} />;
    }
    const load = vi.fn(async () => ({ default: TestPanel }));
    const registry = createAlphaPanelRegistry([descriptor("chart", load)]);
    const first = [panel("panel-1"), panel("panel-2")];

    await act(async () => renderPool(first, registry));
    await flush();
    const firstContainer = container.querySelector(
      "[data-alpha-panel='panel-1']",
    );
    const secondContainer = container.querySelector(
      "[data-alpha-panel='panel-2']",
    );

    await act(async () => renderPool([...first].reverse(), registry));

    expect(container.querySelector("[data-alpha-panel='panel-1']")).toBe(
      firstContainer,
    );
    expect(container.querySelector("[data-alpha-panel='panel-2']")).toBe(
      secondContainer,
    );
    expect(mounts).toEqual(
      new Map([
        ["panel-1", 1],
        ["panel-2", 1],
      ]),
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("把面板配置更新绑定到稳定面板 ID", async () => {
    const onPanelConfigChange = vi.fn();
    let latestProps: AlphaPanelProps | null = null;
    function TestPanel(props: AlphaPanelProps) {
      latestProps = props;
      return null;
    }
    const registry = createAlphaPanelRegistry([
      descriptor("chart", async () => ({ default: TestPanel })),
    ]);

    await act(async () =>
      renderPool([panel("panel-1")], registry, { onPanelConfigChange }),
    );
    await flush();
    act(() => latestProps?.onConfigChange({ interval: "1h" }));

    expect(onPanelConfigChange).toHaveBeenCalledWith("panel-1", {
      interval: "1h",
    });
  });

  it("单个面板加载失败时不影响其他面板", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function HealthyPanel() {
      return <div data-testid="healthy-panel">healthy</div>;
    }
    const registry = createAlphaPanelRegistry([
      descriptor("broken", async () => {
        throw new Error("chunk unavailable");
      }),
      descriptor("healthy", async () => ({ default: HealthyPanel })),
    ]);

    await act(async () =>
      renderPool(
        [panel("broken-1", "broken"), panel("healthy-1", "healthy")],
        registry,
      ),
    );
    await flush();

    expect(container.textContent).toContain("workstation.panel.failed");
    expect(
      container.querySelector("[data-testid='healthy-panel']"),
    ).not.toBeNull();
  });
});
