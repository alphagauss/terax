/**
 * 本文件测试 Alpha 前端业务 API 封装。
 * 锁定 Rust 代理请求参数、响应校验和回测分片聚合，不访问真实服务。
 */

import {
  getAlphaBacktestSeries,
  getAlphaBars,
  getAlphaDataOverview,
  getAlphaSecurity,
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
            asset_type: "stock",
            board: null,
            listed_date: "1991-04-03",
            delisted_date: null,
            status: "active",
            data_state: "complete",
            total_bar_count: 10,
            data_start: "2026-07-01 00:00:00",
            data_end: "2026-07-30 00:00:00",
            latest_updated_at: "2026-07-30 16:00:00",
            intervals: ["d"],
            coverage: {
              d: {
                start: "2026-07-01 00:00:00",
                end: "2026-07-30 00:00:00",
                rows: 10,
                updated_at: "2026-07-30 16:00:00",
              },
            },
          },
        ],
        total: 1,
        limit: 25,
        offset: 50,
      },
    });

    await expect(
      getAlphaSecurities({ q: "000001", limit: 25, offset: 50 }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{ vt_symbol: "000001.SZ" }],
    });
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/alpha/securities",
      query: [
        { name: "q", value: "000001" },
        { name: "limit", value: "25" },
        { name: "offset", value: "50" },
      ],
    });
  });

  it("queries one security through the existing detail endpoint", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        vt_symbol: "000001.SZSE",
        symbol: "000001",
        exchange: "SZSE",
        name: "Ping An Bank",
        asset_type: "stock",
        board: null,
        listed_date: "1991-04-03",
        delisted_date: null,
        status: "active",
        data_state: "complete",
        total_bar_count: 10,
        data_start: "2026-07-01 00:00:00",
        data_end: "2026-07-30 00:00:00",
        latest_updated_at: "2026-07-30 16:00:00",
        intervals: ["d", "1m", "tick"],
        coverage: {},
        price_tick: 0.01,
      },
    });

    await expect(getAlphaSecurity("000001.SZSE")).resolves.toMatchObject({
      vt_symbol: "000001.SZSE",
      intervals: ["d", "1m", "tick"],
    });
    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/alpha/securities/000001.SZSE",
      query: [],
    });
  });

  it("bypasses the data overview cache only for manual refresh", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        summary: {
          security_count: 1,
          profile_count: 1,
          bar_security_count: 1,
          total_bar_count: 10,
          data_start: "2026-07-01 00:00:00",
          data_end: "2026-07-30 00:00:00",
          latest_updated_at: "2026-07-30 16:00:00",
        },
        facets: {
          exchanges: [{ value: "SZ", count: 1 }],
          asset_types: [{ value: "stock", count: 1 }],
          data_states: [{ value: "complete", count: 1 }],
          intervals: [{ value: "d", security_count: 1, row_count: 10 }],
        },
      },
    });

    await getAlphaDataOverview();
    await getAlphaDataOverview(true);

    expect(requestMock.mock.calls.map(([request]) => request.query)).toEqual([
      [],
      [{ name: "force_refresh", value: "true" }],
    ]);
  });

  it("uses the chart-safe daily bar query", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        vt_symbol: "000001.SZ",
        interval: "d",
        adjust: "forward",
        has_more_before: false,
        next_before: null,
        actual_start: "2026-07-30T00:00:00",
        actual_end: "2026-07-30T00:00:00",
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
      items: [
        {
          time: { kind: "trading-day", date: "2026-07-30" },
          close: 10.5,
          amount: null,
          openInterest: null,
        },
      ],
      hasMoreBefore: false,
      nextBefore: null,
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

  it("normalizes explicitly zoned intraday bars to absolute time", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        has_more_before: false,
        next_before: null,
        actual_start: "2026-07-30 09:30:00",
        actual_end: "2026-07-30 09:30:00",
        items: [
          {
            time: "2026-07-30T09:30:00+08:00",
            open: 10,
            high: 11,
            low: 9,
            close: 10.5,
            volume: 100,
            amount: 1000,
            open_interest: 20,
          },
        ],
      },
    });

    await expect(
      getAlphaBars("000001.SZ", { interval: "1m" }),
    ).resolves.toMatchObject({
      items: [
        {
          time: { kind: "instant", epochSeconds: 1785375000 },
          openInterest: 20,
        },
      ],
    });
  });

  it("passes the exclusive history cursor without inventing a start date", async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        items: [],
        has_more_before: false,
        next_before: null,
        actual_start: null,
        actual_end: null,
      },
    });

    await getAlphaBars("000001.SZ", {
      before: "2026-07-30T00:00:00",
      limit: 200,
    });

    expect(requestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/alpha/bars",
      query: [
        { name: "vt_symbol", value: "000001.SZ" },
        { name: "interval", value: "d" },
        { name: "adjust", value: "forward" },
        { name: "limit", value: "200" },
        { name: "before", value: "2026-07-30T00:00:00" },
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
        has_more_before: false,
        next_before: null,
        actual_start: null,
        actual_end: null,
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
