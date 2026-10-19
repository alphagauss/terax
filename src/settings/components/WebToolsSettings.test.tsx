// @vitest-environment happy-dom
import { act, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WebToolsSettings } from "./WebToolsSettings";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  listen: vi.fn(),
  loadAgents: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: mocks.read,
  setSharedStoreKey: mocks.set,
  onSharedStoreChange: mocks.listen,
}));
vi.mock("@/modules/ai/lib/agents", () => ({ loadAgents: mocks.loadAgents }));
vi.mock("@/components/controls/select", () => {
  const Wrapper = ({ children }: PropsWithChildren) => <>{children}</>;
  return {
    Select: ({
      children,
      value,
      disabled,
      onValueChange,
    }: PropsWithChildren<{
      value: string;
      disabled: boolean;
      onValueChange: (value: string) => void;
    }>) => (
      <button
        type="button"
        data-value={value}
        disabled={disabled}
        onClick={() => onValueChange("deepseek")}
      >
        {children}
      </button>
    ),
    SelectContent: Wrapper,
    SelectItem: Wrapper,
    SelectTrigger: Wrapper,
    SelectValue: () => null,
  };
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("does not let an older refresh overwrite the authoritative value after saving", async () => {
  mocks.read.mockResolvedValue({});
  mocks.set.mockResolvedValue(undefined);
  mocks.loadAgents.mockResolvedValue([]);
  mocks.listen.mockResolvedValue(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WebToolsSettings />));
    let resolveOld: (value: unknown) => void = () => {};
    mocks.read.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const refresh = mocks.listen.mock.calls[0][1] as () => Promise<void>;
    const oldRead = refresh();
    mocks.read.mockResolvedValue({ "web.searchProvider": "deepseek" });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("button")?.click(),
    );
    expect(mocks.set).toHaveBeenCalledWith(
      "settings",
      "web.searchProvider",
      "deepseek",
    );
    expect(mocks.loadAgents).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOld({});
      await oldRead;
    });
    expect(container.querySelector("button")?.getAttribute("data-value")).toBe(
      "deepseek",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
