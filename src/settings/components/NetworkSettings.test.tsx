// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NetworkSettings } from "@/settings/components/NetworkSettings";
import { useNetworkStore } from "@/modules/network/settings";

const io = vi.hoisted(() => ({ save: vi.fn(), reportError: vi.fn() }));
vi.mock("@/modules/network/settings", async (original) => {
  const actual = await original<typeof import("@/modules/network/settings")>();
  return {
    ...actual,
    useNetworkSettings: () => actual.useNetworkStore(),
    setGlobalNetworkMode: io.save,
  };
});
vi.mock("@/lib/errors", () => ({ reportError: io.reportError }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("点击即时预览，保存失败回到权威值，成功后保留新选择且不提交代理表单", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useNetworkStore.setState({
    values: { mode: "system", proxyUrl: "http://127.0.0.1:7890" },
    ready: true,
    error: false,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let resolveSave: () => void = () => {};
  let rejectSave: (error: Error) => void = () => {};
  io.save.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        resolveSave = resolve;
        rejectSave = reject;
      }),
  );
  const selected = () =>
    host.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
  const choose = (label: string) =>
    host.querySelector<HTMLButtonElement>(`[role="radio"][value="${label}"]`);
  try {
    await act(async () => root.render(<NetworkSettings />));
    expect(selected()).toBe("network.system");
    await act(async () => choose("shared")?.click());
    expect(selected()).toBe("network.proxy");
    expect(
      host.querySelector('[role="radiogroup"]')?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(io.save).toHaveBeenCalledExactlyOnceWith("shared");
    await act(async () => rejectSave(new Error("save failed")));
    expect(selected()).toBe("network.system");
    expect(io.reportError).toHaveBeenCalledOnce();
    await act(async () => choose("direct")?.click());
    expect(selected()).toBe("network.direct");
    await act(async () => {
      useNetworkStore.setState({
        values: { ...useNetworkStore.getState().values, mode: "direct" },
      });
      resolveSave();
    });
    expect(selected()).toBe("network.direct");
    expect(
      host.querySelector('[role="radiogroup"]')?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(io.save).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
