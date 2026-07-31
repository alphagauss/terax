/**
 * 本文件测试 Alpha 前端业务 API 封装。
 * 锁定 Rust 代理请求参数、响应校验和回测分片聚合，不访问真实服务。
 */

import {
  getAlphaBacktestSeries,
  getAlphaBars,
  getAlphaSecurities,
  getAlphaSettings,
  updateAlphaSettings,
} from "@/modules/alpha/api";
import { requestAlpha } from "@/modules/alpha/native";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/alpha/native", () => ({
  requestAlpha: vi.fn(),
}));

const requestMock = vi.mocked(requestAlpha);

describe("Alpha API client", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("queries and validates the first securities page", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        items: [
          {
            vt_symbol: "000001.SZ",
            symbol: "000001",
            exchange: "SZ",
            name: "Ping An Bank",
            product: "stock",
            status: "active",
            latest_bar_date: "2026-07-30",
          },
        ],
        total: 1,
      },
    });

    await expect(getAlphaSecurities(25)).resolves.toMatchObject({
      total: 1,
      items: [{ vt_symbol: "000001.SZ" }],
    });
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/alpha/securities",
      query: [{ name: "limit", value: "25" }],
    });
  });

  it("uses the chart-safe daily bar query", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        vt_symbol: "000001.SZ",
        interval: "d",
        adjust: "forward",
        items: [
          {
            time: "2026-07-30T00:00:00",
            open: 10,
            high: 11,
            low: 9,
            close: 10.5,
            volume: 100,
            amount: null,
          },
        ],
      },
    });

    await expect(getAlphaBars("000001.SZ")).resolves.toMatchObject({
      items: [{ close: 10.5 }],
    });
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/alpha/bars",
      query: [
        { name: "vt_symbol", value: "000001.SZ" },
        { name: "interval", value: "d" },
        { name: "adjust", value: "forward" },
        { name: "limit", value: "500" },
      ],
    });
  });

  it("rejects malformed bar dates before they reach the financial chart", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        vt_symbol: "000001.SZ",
        interval: "d",
        adjust: "forward",
        items: [
          {
            time: "invalid",
            open: 10,
            high: 11,
            low: 9,
            close: 10.5,
            volume: 100,
            amount: null,
          },
        ],
      },
    });

    await expect(getAlphaBars("000001.SZ")).rejects.toThrow();
  });

  it("merges equity and drawdown fragments without recalculating them", async () => {
    requestMock
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: {
          items: [{ date: "2026-07-30", equity: 1_010_000 }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: {
          items: [{ date: "2026-07-30", drawdown: -0.02 }],
        },
      });

    await expect(getAlphaBacktestSeries("result one")).resolves.toEqual({
      equity: [{ date: "2026-07-30", equity: 1_010_000 }],
      drawdown: [{ date: "2026-07-30", drawdown: -0.02 }],
    });
    expect(requestMock.mock.calls.map(([request]) => request.path)).toEqual([
      "/api/alpha/backtests/result%20one/equity",
      "/api/alpha/backtests/result%20one/drawdown",
    ]);
  });

  it("rejects non-success responses before rendering", async () => {
    requestMock.mockResolvedValue({
      status: 503,
      headers: {},
      body: { detail: "database unavailable" },
    });

    await expect(getAlphaSecurities()).rejects.toThrow(
      "Alpha 503: database unavailable",
    );
  });

  it("loads and saves the Alpha data directory", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: { data_dir: "D:/Alpha Data" },
    });

    await expect(getAlphaSettings()).resolves.toEqual({
      dataDir: "D:/Alpha Data",
    });
    await expect(
      updateAlphaSettings({ dataDir: "D:/Alpha Data" }),
    ).resolves.toEqual({ dataDir: "D:/Alpha Data" });
    expect(requestMock.mock.calls).toEqual([
      [
        {
          method: "GET",
          path: "/api/alpha/settings",
          query: [],
        },
      ],
      [
        {
          method: "POST",
          path: "/api/alpha/settings",
          body: { data_dir: "D:/Alpha Data" },
        },
      ],
    ]);
  });
});
