/**
 * 本文件测试终端缓冲区行范围的纯文本读取。
 * 锁定范围钳制、缺失行处理和尾部空行裁剪规则。
 */

import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { readRangeText } from "./readBlock";

function fakeTerm(lines: (string | undefined)[]): Terminal {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) =>
          lines[index] === undefined
            ? undefined
            : { translateToString: () => lines[index] as string },
      },
    },
  } as unknown as Terminal;
}

describe("readRangeText", () => {
  it("连接软换行时保留真实空格，去掉空单元格填充并保留硬换行", () => {
    const rows = [
      { text: "中文 ", isWrapped: false },
      { text: "two", isWrapped: true },
      { text: "next", isWrapped: false },
    ];
    const term = {
      buffer: {
        active: {
          length: rows.length,
          getLine: (i: number) =>
            rows[i] && {
              isWrapped: rows[i].isWrapped,
              translateToString: (trim: boolean) =>
                trim ? rows[i].text : `${rows[i].text}   `,
            },
        },
      },
    } as unknown as Terminal;
    expect(readRangeText(term, 0, 2)).toBe("中文 two\nnext");
  });
  it("连接请求范围内的行", () => {
    expect(readRangeText(fakeTerm(["a", "b", "c"]), 0, 2)).toBe("a\nb\nc");
  });

  it("移除末尾空行", () => {
    expect(readRangeText(fakeTerm(["a", "b", "c", "", ""]), 0, 4)).toBe(
      "a\nb\nc",
    );
  });

  it("将超出范围的结束行钳制到缓冲区末尾", () => {
    expect(readRangeText(fakeTerm(["a", "b", "c"]), 1, 99)).toBe("b\nc");
  });

  it("将负数起始行钳制到零", () => {
    expect(readRangeText(fakeTerm(["a", "b", "c"]), -5, 2)).toBe("a\nb\nc");
  });

  it("全为空行时返回空字符串", () => {
    expect(readRangeText(fakeTerm(["", ""]), 0, 1)).toBe("");
  });

  it("将缺失行视为空行", () => {
    expect(readRangeText(fakeTerm(["x0", undefined, "x2"]), 0, 2)).toBe(
      "x0\n\nx2",
    );
  });
});
