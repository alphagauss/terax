/**
 * 本文件测试 Explorer 上下文操作的相对路径计算。
 * 重点锁定路径分量边界，避免把同前缀的兄弟路径误判为后代。
 */

import { describe, expect, it } from "vitest";
import { relativePath } from "./contextActions";

describe("relativePath", () => {
  it("根路径自身返回点号", () => {
    expect(relativePath("/a/b", "/a/b")).toBe(".");
  });

  it("后代路径移除根路径前缀", () => {
    expect(relativePath("/a/b", "/a/b/c/d")).toBe("c/d");
  });

  it("支持带分隔符结尾的根目录", () => {
    expect(relativePath("/", "/src/App.tsx")).toBe("src/App.tsx");
    expect(relativePath("D:/", "D:/src/App.tsx")).toBe("src/App.tsx");
  });

  it("忽略 Windows 根目录的大小写差异并保留文件名大小写", () => {
    expect(relativePath("D:/Repo", "d:/repo/src/App.tsx", true)).toBe(
      "src/App.tsx",
    );
  });

  it("大小写转换改变字符长度时不会误截取路径", () => {
    const path = "d:/i\u0307/src/App.tsx";
    expect(relativePath("D:/İ", path, true)).toBe(path);
  });

  it("保留仅共享字符串前缀的兄弟路径", () => {
    expect(relativePath("/a/b", "/a/bc/d")).toBe("/a/bc/d");
  });

  it("保留无关路径", () => {
    expect(relativePath("/a/b", "/x/y")).toBe("/x/y");
  });
});
