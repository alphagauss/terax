/**
 * 本文件测试 Alpha 服务可用性边界。
 * 重点锁定停服时不挂载业务子树，以及服务恢复后复用同一页面入口。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const mocks = vi.hoisted(() => ({
  service: {
    data: undefined as
      | {
          running: boolean;
          configured: boolean;
          issue: "portConflict" | null;
          port: number;
        }
      | undefined,
    error: null as Error | null,
    isFetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@/modules/alpha/query", () => ({
  useAlphaServiceStatus: () => mocks.service,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AlphaServiceBoundary } from "@/modules/alpha/components/AlphaServiceBoundary";

describe("AlphaServiceBoundary", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.service.data = undefined;
    mocks.service.error = null;
    mocks.service.isFetching = false;
    mocks.service.refetch.mockReset();
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("服务停止时不挂载业务子树", async () => {
    mocks.service.data = {
      running: false,
      configured: true,
      issue: null,
      port: 11123,
    };
    const BusinessPage = vi.fn(() => <div>business</div>);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AlphaServiceBoundary visible>
          <BusinessPage />
        </AlphaServiceBoundary>,
      );
    });

    expect(BusinessPage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("service.unavailableTitle");
    act(() => root.unmount());
  });

  it("服务运行时挂载业务子树", async () => {
    mocks.service.data = {
      running: true,
      configured: true,
      issue: null,
      port: 11123,
    };
    const BusinessPage = vi.fn(() => <div>business</div>);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AlphaServiceBoundary visible>
          <BusinessPage />
        </AlphaServiceBoundary>,
      );
    });

    expect(BusinessPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("business");
    act(() => root.unmount());
  });

  it("后台探活失败时保留已有业务页面", async () => {
    mocks.service.data = {
      running: true,
      configured: true,
      issue: null,
      port: 11123,
    };
    mocks.service.error = new Error("temporary failure");
    const BusinessPage = vi.fn(() => <div>business</div>);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <AlphaServiceBoundary visible>
          <BusinessPage />
        </AlphaServiceBoundary>,
      );
    });

    expect(BusinessPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("business");
    act(() => root.unmount());
  });
});
