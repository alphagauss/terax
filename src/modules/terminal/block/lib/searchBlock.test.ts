import { expect, it } from "vitest";
import type { IBuffer } from "@xterm/xterm";
import { searchRange } from "./searchBlock";

it("跨软换行搜索并按中文、组合字符和 UTF-16 长度定位单元格", () => {
  const rows = [
    {
      wrapped: false,
      cells: [
        ["中", 2],
        ["", 0],
        ["é", 1],
        ["a", 1],
      ],
    },
    {
      wrapped: true,
      cells: [
        ["b", 1],
        ["\u{1f600}", 2],
        ["", 0],
        [" ", 1],
      ],
    },
    { wrapped: false, cells: [["c", 1]] },
  ];
  const buffer = {
    length: rows.length,
    getLine: (row: number) =>
      rows[row] && {
        isWrapped: rows[row].wrapped,
        length: rows[row].cells.length,
        getCell: (col: number) => ({
          getChars: () => rows[row].cells[col][0],
          getWidth: () => rows[row].cells[col][1],
        }),
      },
  } as unknown as IBuffer;
  expect(searchRange(buffer, 0, 2, "éab\u{1f600}")).toEqual([
    {
      line: 0,
      segments: [
        { line: 0, col: 2, len: 2 },
        { line: 1, col: 0, len: 3 },
      ],
    },
  ]);
  expect(searchRange(buffer, 0, 2, "\u{1f600}c")).toEqual([]);
  expect(searchRange(buffer, 0, 0, "ab")).toEqual([]);
});
