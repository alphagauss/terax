/**
 * 本文件测试 Provider 多模型控件的用户添加语义。
 * 重点锁定服务端选择与手动输入写入不同来源，且远端发现本身不会自动持久化。
 */

// @vitest-environment happy-dom

import type { ConfiguredModel } from "@/modules/ai/config";
import { createProviderConnection } from "@/modules/ai/providerRegistry";
import {
  act,
  type ButtonHTMLAttributes,
  createElement,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  open: null as ((open: boolean) => void) | null,
}));

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => createElement("button", { type: "button", ...props }, children),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) =>
    createElement("input", props),
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    mocks.open = onOpenChange ?? null;
    return children;
  },
  PopoverContent: ({
    children,
    sideOffset: _sideOffset,
    align: _align,
    ...props
  }: HTMLAttributes<HTMLDivElement> & {
    sideOffset?: number;
    align?: string;
  }) => createElement("div", props, children),
  PopoverTrigger: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/spinner", () => ({ Spinner: () => null }));
vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { id?: string; count?: number }) =>
      options?.id
        ? `${key}:${options.id}`
        : options?.count !== undefined
          ? `${key}:${options.count}`
          : key,
  }),
}));
vi.mock("@/modules/ai/lib/modelCatalog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  modelCatalog: { list: mocks.list },
}));

import { ProviderModelPicker } from "./ProviderModelPicker";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  mocks.list.mockReset();
});

async function renderPicker(
  onChange: (models: ConfiguredModel[]) => Promise<void>,
  models: Array<{ id: string; source: "discovered" | "manual" }> = [],
) {
  mocks.list.mockResolvedValue(["remote-model"]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ProviderModelPicker
        connection={createProviderConnection({
          instanceId: "builtin:openai",
          provider: "openai",
          credentialValue: "secret",
        })}
        models={models}
        onChange={onChange}
      />,
    );
  });
  await act(async () => {
    mocks.open?.(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProviderModelPicker", () => {
  it("only persists explicit remote and manual additions with their source", async () => {
    const onChange = vi
      .fn<(models: ConfiguredModel[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    await renderPicker(onChange);
    expect(onChange).not.toHaveBeenCalled();

    const remoteButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="models.catalog.add:remote-model"]',
    );
    if (!remoteButton) throw new Error("remote model action was not rendered");
    await act(async () => remoteButton?.click());
    expect(onChange).toHaveBeenLastCalledWith([
      {
        id: "remote-model",
        source: "discovered",
      },
    ]);

    const input = container?.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("model input was not rendered");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "manual-model");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenLastCalledWith([
      { id: "manual-model", source: "manual" },
    ]);
  });

  it("removes an added model without changing the provider catalog", async () => {
    const onChange = vi
      .fn<(models: ConfiguredModel[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    await renderPicker(onChange, [{ id: "manual-model", source: "manual" }]);
    expect(container?.textContent).toContain("models.catalog.source.manual");

    const remove = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="models.catalog.remove:manual-model"]',
    );
    if (!remove) throw new Error("remove model action was not rendered");
    await act(async () => remove.click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("serializes model updates so rapid actions cannot overwrite each other", async () => {
    let finishSave: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    await renderPicker(onChange);

    const add = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="models.catalog.add:remote-model"]',
    );
    if (!add) throw new Error("remote model action was not rendered");
    await act(async () => {
      add.click();
      add.click();
    });
    expect(onChange).toHaveBeenCalledOnce();

    await act(async () => finishSave?.());
  });
});
