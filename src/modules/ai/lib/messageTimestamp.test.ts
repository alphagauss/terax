/**
 * 本文件验证 AI 消息和会话列表使用的时间展示规则。
 * 锁定今天、省略年份的同年历史和包含年份的往年历史三种边界。
 */

import { describe, expect, it } from "vitest";
import { messageTimestampFormatOptions } from "./messageTimestamp";

const now = new Date(2026, 6, 26, 15, 30);

describe("AI message timestamp formatting", () => {
  it("shows only time for messages from today", () => {
    expect(
      messageTimestampFormatOptions(new Date(2026, 6, 26, 9, 5).getTime(), now),
    ).toEqual({ hour: "2-digit", minute: "2-digit", hour12: false });
  });

  it("adds month and day for earlier messages in the current year", () => {
    expect(
      messageTimestampFormatOptions(new Date(2026, 0, 1, 9, 5).getTime(), now),
    ).toEqual({
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  });

  it("adds the year for messages from previous years", () => {
    expect(
      messageTimestampFormatOptions(
        new Date(2025, 11, 31, 9, 5).getTime(),
        now,
      ),
    ).toEqual({
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  });
});
