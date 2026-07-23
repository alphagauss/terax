/**
 * 本文件测试文件传输结构化错误的运行时解析。
 * 锁定未知 IPC 值不会被误判为可信错误码。
 */

import { describe, expect, it } from "vitest";
import { parseTransferFailure } from "./errors";

describe("transfer failure parsing", () => {
  it("accepts the complete backend failure shape", () => {
    expect(
      parseTransferFailure({
        code: "connection_lost",
        detail: "socket closed",
        retryable: true,
      }),
    ).toEqual({
      code: "connection_lost",
      detail: "socket closed",
      retryable: true,
    });
  });

  it("rejects unknown codes and incomplete values", () => {
    expect(
      parseTransferFailure({
        code: "made_up",
        detail: "bad",
        retryable: true,
      }),
    ).toBeNull();
    expect(
      parseTransferFailure({
        code: "io_failed",
        detail: "bad",
      }),
    ).toBeNull();
    expect(parseTransferFailure("io_failed")).toBeNull();
  });
});
