/**
 * 本文件测试 Python 文件识别和跨平台父目录推导。
 * 锁定大小写扩展名、反斜杠路径与根目录边界。
 */

import { describe, expect, it } from "vitest";
import { isPythonFile, pythonFileName, pythonParentDirectory } from "./path";

describe("Python path helpers", () => {
  it("recognizes Python source extensions case-insensitively", () => {
    expect(isPythonFile("/work/main.py")).toBe(true);
    expect(isPythonFile("C:\\work\\MAIN.PY")).toBe(true);
    expect(isPythonFile("/work/main.py.txt")).toBe(false);
  });

  it("handles POSIX and Windows path boundaries", () => {
    expect(pythonFileName("C:\\work\\main.py")).toBe("main.py");
    expect(pythonParentDirectory("/main.py")).toBe("/");
    expect(pythonParentDirectory("C:\\main.py")).toBe("C:/");
    expect(pythonParentDirectory("relative.py")).toBeNull();
  });
});
