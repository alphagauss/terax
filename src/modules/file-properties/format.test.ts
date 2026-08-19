/**
 * 本文件验证文件属性值的纯格式化逻辑。
 * 测试锁定 1024 进制单位以及 POSIX 特殊执行位不得被普通 rwx 文本掩盖。
 */

import { formatBytes, formatPosixMode } from "@/modules/file-properties/format";
import { describe, expect, it } from "vitest";

describe("文件属性格式化", () => {
  it("使用紧凑的 1024 进制字节单位", () => {
    expect(formatBytes(1023, "en")).toBe("1,023 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
  });

  it("保留 POSIX 特殊执行位", () => {
    expect(formatPosixMode(0o755)).toBe("0755 (rwxr-xr-x)");
    expect(formatPosixMode(0o4755)).toBe("04755 (rwsr-xr-x)");
    expect(formatPosixMode(0o2640)).toBe("02640 (rw-r-S---)");
    expect(formatPosixMode(0o1000)).toBe("01000 (--------T)");
  });
});
