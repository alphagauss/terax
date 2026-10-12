import { beforeEach, expect, it, vi } from "vitest";
import {
  clearErrors,
  dismissError,
  elapseErrors,
  errorDetails,
  errorStore,
  reportError,
} from "@/lib/errors";

beforeEach(() => {
  clearErrors();
  vi.restoreAllMocks();
});

it("短时间重复错误合并，关闭不删除历史也不被轮询重新弹出", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(10000);
  const id = reportError("保存失败", {
    source: "a.ts",
    error: { code: "EACCES", message: "denied" },
  });
  const updated = vi.fn();
  const unsubscribe = errorStore.subscribe(updated);
  elapseErrors(2000, new Set());
  expect(updated).not.toHaveBeenCalled();
  unsubscribe();
  clock.mockReturnValue(11000);
  expect(
    reportError("保存失败", {
      source: "a.ts",
      error: { code: "EACCES", message: "denied" },
    }),
  ).toBe(id);
  expect(errorStore.getState().reports[0]).toMatchObject({
    count: 2,
  });
  dismissError(id);
  reportError("保存失败", {
    source: "a.ts",
    error: { code: "EACCES", message: "denied" },
  });
  expect(errorStore.getState().reports[0]).toMatchObject({
    visible: false,
    count: 3,
  });
  expect(reportError("保存失败", { source: "b.ts" })).not.toBe(id);
});

it("可见错误最多三条，历史有界且不会挤掉仍在阅读的错误", () => {
  const pinned = reportError("未保存");
  for (let i = 0; i < 70; i++) reportError(`失败 ${i}`);
  const reports = errorStore.getState().reports;
  expect(reports).toHaveLength(50);
  expect(reports.filter((item) => item.visible)).toHaveLength(3);
  expect(reports.some((item) => item.id === pinned)).toBe(true);
});

it("诊断保留原因链但不包含密钥、请求正文或循环对象", () => {
  const error = {
    message: 'password="secret with spaces" Authorization: Bearer abc123',
    code: "EIO",
    cause: {} as unknown,
    requestBody: "private prompt",
  };
  error.cause = error;
  const details = errorDetails(error);
  expect(details).toContain("EIO");
  expect(details).not.toContain("secret with spaces");
  expect(details).not.toContain("abc123");
  expect(details).not.toContain("private prompt");
  const quoted = errorDetails({
    message: 'password="line1\nsecret\\"value" token=abc',
  });
  expect(quoted).not.toContain("line1");
  expect(quoted).not.toContain("value");
  expect(quoted).not.toContain("abc");
  expect(() =>
    reportError("失败", {
      error: Object.defineProperty({}, "message", {
        get() {
          throw new Error("getter failed");
        },
      }),
    }),
  ).not.toThrow();
  expect(
    errorDetails({ message: "a".repeat(20000) }).length,
  ).toBeLessThanOrEqual(16000);
});
