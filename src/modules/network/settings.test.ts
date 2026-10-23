/**
 * 本文件验证合并到通用设置后的网络缓存边界。
 * 普通偏好变化必须保留模型目录缓存，网络配置与凭据变化才使缓存失效。
 */
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModelCatalog } from "@/modules/ai/lib/modelCatalog";
import { createProviderConnection } from "@/modules/ai/providerRegistry";
import { readSharedStore } from "@/lib/sharedStore";
import {
  setNetworkRoute,
  setGlobalNetworkMode,
  effectiveNetworkMode,
  useNetworkSettings,
  useNetworkStore,
} from "@/modules/network/settings";

const storage = vi.hoisted(() => ({
  values: {
    theme: "light",
    "network.proxyUrl": "http://127.0.0.1:8080",
  } as Record<string, unknown>,
  listeners: {} as Record<string, () => void | Promise<void>>,
  systemRevision: "system-1",
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    expect(command).toBe("network_system_proxy_revision");
    return storage.systemRevision;
  }),
}));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: vi.fn(async (store: string) => {
    expect(store).toBe("settings");
    return { ...storage.values };
  }),
  setSharedStoreKey: async (store: string, key: string, value: unknown) => {
    expect(store).toBe("settings");
    storage.values[key] = value;
  },
  deleteSharedStoreKey: async (store: string, key: string) => {
    expect(store).toBe("settings");
    delete storage.values[key];
  },
  onSharedStoreChange: async (
    store: string,
    callback: () => void | Promise<void>,
  ) => {
    storage.listeners[store] = callback;
    await callback();
    return () => {
      delete storage.listeners[store];
    };
  },
}));

/** 挂载实际设置订阅，不渲染额外界面。 */
function SettingsConsumer() {
  useNetworkSettings();
  return null;
}

it("preserves catalog cache for unrelated preferences and refreshes it for network changes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  const request = vi.fn(async () => ({
    status: 200,
    body: '{"data":[{"id":"model"}]}',
  }));
  const catalog = new ModelCatalog(request);
  const connection = createProviderConnection({
    provider: "openai",
    instanceId: "builtin:openai",
    credentialValue: "test",
  });
  try {
    await act(async () => {
      root.render(createElement(SettingsConsumer));
    });
    await catalog.list(connection);
    storage.values.theme = "dark";
    await act(async () => {
      await storage.listeners.settings();
    });
    await catalog.list(connection);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await setNetworkRoute("provider:builtin:openai", "shared");
    });
    await catalog.list(connection);
    expect(request).toHaveBeenCalledTimes(2);
    expect(storage.values.theme).toBe("dark");
    expect(storage.values["network.provider:builtin:openai"]).toBe("shared");
    await act(async () => {
      await storage.listeners["keys-epoch"]();
    });
    await catalog.list(connection);
    expect(request).toHaveBeenCalledTimes(3);
    storage.systemRevision = "system-2";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await catalog.list(connection);
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
  }
});

it("persists explicit direct and shared overrides and removes only inherited routes", async () => {
  await setNetworkRoute("provider:custom", "direct");
  expect(storage.values["network.provider:custom"]).toBe("direct");
  await setNetworkRoute("provider:custom", "shared");
  expect(storage.values["network.provider:custom"]).toBe("shared");
  await setNetworkRoute("provider:custom", "inherit");
  expect(storage.values).not.toHaveProperty("network.provider:custom");
  for (const mode of ["system", "shared", "direct"] as const) {
    await setGlobalNetworkMode(mode);
    expect(useNetworkStore.getState().values.mode).toBe(mode);
    expect(
      effectiveNetworkMode(
        { mode, "provider:custom": "direct" },
        "provider:custom",
      ),
    ).toBe("direct");
    expect(
      effectiveNetworkMode(
        { mode, "provider:custom": "shared" },
        "provider:custom",
      ),
    ).toBe("shared");
    expect(effectiveNetworkMode({ mode }, "provider:custom")).toBe(mode);
  }
  expect(storage.values["network.proxyUrl"]).toBe("http://127.0.0.1:8080");
  expect(effectiveNetworkMode({}, "markdown")).toBe("system");
});

it("ignores an older refresh that completes after a new mode is saved", async () => {
  let finishRead: (values: Record<string, unknown>) => void = () => {};
  vi.mocked(readSharedStore).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  const stale = storage.listeners.settings();
  await setGlobalNetworkMode("direct");
  finishRead({ ...storage.values, "network.mode": "system" });
  await stale;
  expect(useNetworkStore.getState().values.mode).toBe("direct");
});
