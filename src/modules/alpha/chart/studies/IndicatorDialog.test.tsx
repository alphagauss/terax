/**
 * 本文件测试懒加载指标 Dialog 的选择、参数校验和实例提交。
 * 重点锁定客户端只编辑配置，definition 仍来自服务端查询边界。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const definitions = [
  {
    type: "sma" as const,
    pane: "main" as const,
    params: [{ key: "period", defaultValue: 20, min: 1, max: 500, step: 1 }],
    outputs: [{ id: "line", kind: "line" as const }],
    levels: [],
  },
];
const queryOptions = vi.hoisted(() => ({ enabled: false }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { enabled: boolean }) => {
    queryOptions.enabled = options.enabled;
    return {
      data: definitions,
      isPending: false,
      isError: false,
    };
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import IndicatorDialog from "@/modules/alpha/chart/studies/IndicatorDialog";
import type { ChartStudyInstance } from "@/modules/alpha/chart/studies/model";
import { WorkbenchPageScope } from "@/modules/workbench/WorkbenchPageOverlays";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("IndicatorDialog", () => {
  let root: ReturnType<typeof createRoot> | null;
  let container: HTMLDivElement;

  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.restoreAllMocks();
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("从已有指标切到新增时不沿用旧编辑目标", async () => {
    const instance: ChartStudyInstance = {
      instanceId: "existing",
      type: "sma",
      visible: true,
      params: { period: 50 },
      styles: { line: { color: "#e0a43c", lineWidth: 2 } },
    };
    const onChange = vi.fn();
    const render = async (target: string | null) =>
      act(async () =>
        root?.render(
          <WorkbenchPageScope visible focused>
            <IndicatorDialog
              open
              editingInstanceId={target}
              instances={[instance]}
              onOpenChange={() => {}}
              onChange={onChange}
            />
          </WorkbenchPageScope>,
        ),
      );
    await render(instance.instanceId);
    expect(
      container.querySelector<HTMLInputElement>('input[type="number"]')?.value,
    ).toBe("50");
    await render(null);
    expect(container.querySelector('input[type="number"]')).toBeNull();
    const select = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("studies.types.sma"),
    );
    await act(async () => select?.click());
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "data.chart.studies.actions.add",
    );
    await act(async () => add?.click());
    expect(onChange).toHaveBeenCalledWith([
      instance,
      expect.objectContaining({ params: { period: 20 } }),
    ]);
  });

  it("正在编辑的指标被外部删除时不假报保存成功", async () => {
    const instance: ChartStudyInstance = {
      instanceId: "existing",
      type: "sma",
      visible: true,
      params: { period: 20 },
      styles: { line: { color: "#e0a43c", lineWidth: 2 } },
    };
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    const render = async (instances: ChartStudyInstance[]) =>
      act(async () =>
        root?.render(
          <WorkbenchPageScope visible focused>
            <IndicatorDialog
              open
              editingInstanceId={instance.instanceId}
              instances={instances}
              onOpenChange={onOpenChange}
              onChange={onChange}
            />
          </WorkbenchPageScope>,
        ),
      );
    await render([instance]);
    await render([]);
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "data.chart.studies.actions.save",
    );
    expect(save?.disabled).toBe(true);
    await act(async () => save?.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "data.chart.studies.dialog.targetRemoved",
    );
  });

  it("从服务端 definition 创建实例并提交修改后的参数", () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <WorkbenchPageScope visible focused>
          <IndicatorDialog
            open={true}
            editingInstanceId={null}
            instances={[]}
            onOpenChange={vi.fn()}
            onChange={onChange}
          />
        </WorkbenchPageScope>,
      );
    });
    const definitionButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("studies.types.sma"));
    act(() => definitionButton?.click());
    const period = document.querySelector<HTMLInputElement>(
      '[id$="-study-param-period"]',
    );
    act(() => {
      if (!period) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(period, "50");
      period.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "data.chart.studies.actions.add");
    act(() => add?.click());

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        instanceId: "sma-00000000-0000-4000-8000-000000000001",
        type: "sma",
        params: { period: 50 },
        styles: { line: { color: "#e0a43c", lineWidth: 2 } },
      }),
    ]);
  });

  it("切换工作页保留参数和线宽草稿，暂停查询并允许其他页面操作", async () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    const instance: ChartStudyInstance = {
      instanceId: "sma-existing",
      type: "sma",
      visible: true,
      params: { period: 20 },
      styles: { line: { color: "#e0a43c", lineWidth: 2 } },
    };
    const render = async (visible: boolean) =>
      act(async () =>
        root?.render(
          <>
            <button type="button" data-navigation="">
              other page
            </button>
            <WorkbenchPageScope visible={visible} focused={visible}>
              <IndicatorDialog
                open
                editingInstanceId={instance.instanceId}
                instances={[{ ...instance, params: { ...instance.params } }]}
                onChange={onChange}
                onOpenChange={onOpenChange}
              />
            </WorkbenchPageScope>
          </>,
        ),
      );
    const find = <T extends HTMLElement>(selector: string): T => {
      const element = container.querySelector<T>(selector);
      if (!element) throw new Error(`Missing element: ${selector}`);
      return element;
    };
    await render(true);
    const period = find<HTMLInputElement>('input[type="number"]');
    const dialog = find<HTMLElement>('[data-workbench-page-overlay="dialog"]');
    await act(async () => {
      find("[data-workbench-page-backdrop]").dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, bubbles: true }),
      );
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    const widths = find<HTMLElement>(
      'fieldset[aria-label="data.chart.studies.styles.width"]',
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(period, "50");
      period.dispatchEvent(new Event("input", { bubbles: true }));
      widths.querySelectorAll("button")[3].click();
    });
    const navigation = find<HTMLButtonElement>("[data-navigation]");
    expect(navigation.closest("[inert]")).toBeNull();
    expect(document.body.style.pointerEvents).toBe("");
    await act(async () => navigation.focus());
    await render(false);
    expect(queryOptions.enabled).toBe(false);
    expect(dialog.inert).toBe(true);
    expect(document.activeElement).toBe(navigation);
    await act(async () =>
      navigation.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    await render(true);
    expect(queryOptions.enabled).toBe(true);
    expect(find('input[type="number"]')).toBe(period);
    expect(period.value).toBe("50");
    expect(
      widths.querySelectorAll("button")[3].getAttribute("aria-pressed"),
    ).toBe("true");
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "data.chart.studies.actions.save",
    );
    expect(save).toBeDefined();
    await act(async () => save?.click());
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        instanceId: instance.instanceId,
        params: { period: 50 },
        styles: { line: { color: "#e0a43c", lineWidth: 4 } },
      }),
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
