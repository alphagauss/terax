/**
 * 本文件测试 Alpha 查询运行时的跨页面服务状态共享。
 * 重点锁定多个页面观察同一缓存时只执行一次初始探活。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const mocks = vi.hoisted(() => ({
  getAlphaStatus: vi.fn(),
}));

vi.mock("@/modules/alpha/native", () => ({
  getAlphaStatus: mocks.getAlphaStatus,
}));

import {
  AlphaQueryProvider,
  clearAlphaQueryCache,
  useAlphaServiceStatus,
} from "@/modules/alpha/query";

function StatusConsumer() {
  const service = useAlphaServiceStatus(true);
  return createElement("span", null, String(service.data?.running));
}

describe("Alpha query runtime", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    clearAlphaQueryCache();
    mocks.getAlphaStatus.mockReset();
    mocks.getAlphaStatus.mockResolvedValue({
      running: true,
      configured: true,
      pythonPath: "C:/Python/python.exe",
      autoStart: true,
      port: 11123,
      issue: null,
    });
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
  });

  it("多个页面共享一次初始服务探活", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(
            AlphaQueryProvider,
            null,
            createElement(StatusConsumer),
          ),
          createElement(
            AlphaQueryProvider,
            null,
            createElement(StatusConsumer),
          ),
        ),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(mocks.getAlphaStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("truetrue");
    act(() => root.unmount());
  });
});
