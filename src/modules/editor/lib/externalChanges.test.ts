import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  history,
  historyField,
  redo,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { ExternalChange } from "@uiw/react-codemirror";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { externalChanges } from "./externalChanges";

describe("磁盘刷新", () => {
  it.each([4095, 4096, 4097])(
    "分段比较在 %i 字符边界保持精确的最小变更",
    (length) => {
      const prefix = "志".repeat(length);
      const suffix = "录".repeat(length);
      const state = EditorState.create({
        doc: `${prefix}旧内容${suffix}`,
        extensions: [history(), externalChanges],
      });
      const update = state.update({
        changes: {
          from: 0,
          to: state.doc.length,
          insert: `${prefix}新${suffix}`,
        },
        annotations: ExternalChange.of(true),
      });
      const changes: unknown[] = [];
      update.changes.iterChanges((from, to, _from, _to, insert) => {
        changes.push({ from, to, insert: insert.toString() });
      });
      expect(changes).toEqual([{ from: length, to: length + 3, insert: "新" }]);
      expect(update.state.doc.toString()).toBe(`${prefix}新${suffix}`);
      expect(undoDepth(update.state)).toBe(0);
    },
  );
  it("受限堆内反复刷新长日志行，不让子串保留旧全文", () => {
    const source = ts.transpileModule(
      readFileSync(new URL("./externalChanges.ts", import.meta.url), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--expose-gc",
        "--input-type=module",
        "-e",
        `${source}
      const {history} = await import('@codemirror/commands');
      let state = EditorState.create({doc: ('x'.repeat(255)+'\\n').repeat(16384), extensions: [history(), externalChanges]});
      for (let i=0; i<64; i++) {
        state = state.update({changes: {from: 0, to: state.doc.length, insert: state.doc.toString()+'line '+i+'x'.repeat(200)+'\\n'}, annotations: ExternalChange.of(true)}).state;
        global.gc();
      }
      console.log(process.memoryUsage().heapUsed);
    `,
      ],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.stdout.trim())).toBeLessThan(80 * 1024 * 1024);
  }, 35_000);
  it("持续刷新大文本不保留旧全文，并保持光标和用户撤销、重做", () => {
    const initial = "日志\n".repeat(30_000);
    let state = EditorState.create({
      doc: initial,
      extensions: [history(), externalChanges],
    });
    state = state.update({
      changes: { from: 0, insert: "手工编辑" },
      selection: { anchor: 4 },
    }).state;
    for (let index = 0; index < 125; index++) {
      state = state.update({
        changes: {
          from: 0,
          to: state.doc.length,
          insert: `${state.doc.toString()}追加 ${index}\n`,
        },
        annotations: [
          ExternalChange.of(true),
          Transaction.time.of(index * 3000),
        ],
      }).state;
    }
    expect(undoDepth(state)).toBe(1);
    expect(state.selection.main.head).toBe(4);
    const retained = state.toJSON({ history: historyField }).history as {
      done: { changes: unknown }[];
    };
    expect(JSON.stringify(retained).length).toBeLessThan(1000);
    const target = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        state = transaction.state;
      },
    };
    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe(
      initial +
        Array.from({ length: 125 }, (_, index) => `追加 ${index}\n`).join(""),
    );
    expect(redo(target)).toBe(true);
    expect(state.doc.toString().startsWith("手工编辑")).toBe(true);
  });
});
