import i18n, { preloadEn, preloadZhCN } from "@/i18n";
import { beforeAll, describe, expect, it } from "vitest";
import {
  describeToolCall,
  formatToolSummary,
  isToolSummary,
} from "./toolSummary";

beforeAll(async () => {
  await Promise.all([preloadEn(), preloadZhCN()]);
});

const summary = (tool: string, input: unknown, complete = true) =>
  formatToolSummary(
    describeToolCall(tool, input, complete),
    i18n.getFixedT("en", "ai"),
  );

describe("tool call summaries", () => {
  it("distinguishes immediate listing from recursive discovery without leaking defaults during streaming", () => {
    expect(summary("find_files", {}, false)).toBe("");
    expect(summary("find_files", { path: "." }, false)).toBe(".");
    expect(summary("find_files", { path: "." })).toBe("List directory · .");
    expect(
      summary("find_files", {
        path: ".",
        recursive: true,
        glob: "**/*.rs",
        limit: 2000,
      }),
    ).toBe("Recursive search · . · **/*.rs");
    expect(
      summary("find_files", {
        recursive: true,
        include_hidden: true,
        include_directories: true,
      }),
    ).toBe("Recursive search · . · Include hidden · Include directories");
  });

  it.each([
    ["move", { destination: "b.ts" }, "Move · a.ts → b.ts"],
    ["copy", { destination: "b.ts" }, "Copy · a.ts → b.ts"],
    ["delete", {}, "Delete · a.ts"],
    ["delete", { recursive: true }, "Delete recursively · a.ts"],
    ["create_directory", {}, "Create directory · a.ts"],
  ])(
    "describes the %s filesystem operation",
    (operation, options, expected) => {
      expect(
        summary("file_operation", { operation, path: "a.ts", ...options }),
      ).toBe(expected);
    },
  );

  it("describes read ranges, search modes and edits without retaining their bodies", () => {
    expect(
      summary("read_file", { path: "a.ts", start_line: 100, line_count: 50 }),
    ).toBe("a.ts · Lines 100–149");
    expect(
      summary("grep", {
        pattern: "TODO",
        path: "src",
        syntax: "literal",
        output: "files",
        include: ["**/*.ts"],
      }),
    ).toBe("Literal match · Matching files · TODO · src · **/*.ts");
    expect(
      describeToolCall("write_file", {
        path: "a.ts",
        mode: "rewrite",
        content: "secret body",
      }),
    ).toEqual([{ label: "rewrite" }, "a.ts"]);
    expect(summary("write_file", { path: "a.ts" })).toBe("a.ts");
    expect(
      summary("apply_patch", {
        edits: [
          { path: "a.ts", old_text: "secret patch" },
          { path: "a.ts" },
          { path: "b.ts" },
        ],
      }),
    ).toBe("a.ts · 1 more file");
  });

  it("describes process actions, terminal ranges, subagent modes and attachments", () => {
    expect(
      summary("shell_exec", {
        command: "pnpm test",
        cwd: "src",
        shell: "pwsh",
      }),
    ).toBe("pnpm test · src · pwsh");
    expect(
      summary("shell_process", { action: "terminate", process_id: "id" }),
    ).toBe("Terminate · id");
    expect(summary("get_terminal_output", {})).toBe("Last 80 lines");
    const terminalRange = describeToolCall("get_terminal_output", {
      lines: 80,
      offset: 80,
    });
    expect(isToolSummary(terminalRange)).toBe(true);
    expect(formatToolSummary(terminalRange, i18n.getFixedT("en", "ai"))).toBe(
      "Lines 81–160 from end",
    );
    expect(
      formatToolSummary(terminalRange, i18n.getFixedT("zh-CN", "ai")),
    ).toBe("倒数第 81 至 160 行");
    expect(summary("get_terminal_output", { offset: 80 })).toBe(
      "Lines 81–160 from end",
    );
    expect(summary("run_subagent", { task: "Inspect", wait: false })).toBe(
      "Background · Inspect",
    );
    expect(
      summary("run_subagent", {
        label: "Inspect",
        wait: true,
        task: "long task",
      }),
    ).toBe("Wait · Inspect");
    expect(summary("message", { attachments: [{ path: "report.csv" }] })).toBe(
      "Send · Attachments · report.csv",
    );
    expect(summary("shell_list", {})).toBe("");
    expect(summary("shell_list", { include_exited: true })).toBe(
      "Include exited processes",
    );
    expect(summary("unknown", { content: "body" })).toBe("");
  });

  it("keeps persisted summaries independent of language and rejects extra or unbounded data", () => {
    const data = JSON.parse(
      JSON.stringify(
        describeToolCall("file_operation", {
          operation: "delete",
          recursive: true,
          path: "build",
        }),
      ),
    );
    expect(isToolSummary(data)).toBe(true);
    expect(formatToolSummary(data, i18n.getFixedT("en", "ai"))).toBe(
      "Delete recursively · build",
    );
    expect(formatToolSummary(data, i18n.getFixedT("zh-CN", "ai"))).toBe(
      "递归删除 · build",
    );
    expect(isToolSummary([{ label: "delete", content: "body" }])).toBe(false);
    expect(isToolSummary(["x".repeat(161)])).toBe(false);
    expect(
      isToolSummary([{ label: "lines", values: { count: Infinity } }]),
    ).toBe(false);
    expect(isToolSummary([{ label: "lineRange", values: { count: 1 } }])).toBe(
      false,
    );
    expect(isToolSummary([{ label: "lines" }])).toBe(false);
    expect(isToolSummary([{ label: "delete", values: { count: 1 } }])).toBe(
      false,
    );
  });

  it("does not infer operations from incomplete booleans or inherited property names", () => {
    expect(summary("find_files", { recursive: null }, false)).toBe("");
    expect(summary("run_subagent", { wait: null }, false)).toBe("");
    expect(
      summary("file_operation", { operation: "toString", path: "a.ts" }),
    ).toBe("a.ts");
    expect(
      summary("shell_process", { action: "constructor", process_id: "id" }),
    ).toBe("id");
    const range = describeToolCall("read_file", {
      path: "a.ts",
      start_line: Number.MAX_SAFE_INTEGER,
      line_count: 2,
    });
    expect(isToolSummary(range)).toBe(true);
    expect(summary("get_terminal_output", { lines: 0 }, false)).toBe("");
  });

  it("redacts and bounds summaries without mutating tool inputs", () => {
    const input = { command: `API_KEY=super-secret-value ${"x".repeat(200)}` };
    const original = input.command;
    const data = describeToolCall("shell_exec", input);
    const text = formatToolSummary(data, i18n.getFixedT("en", "ai"));
    expect(text).toContain("API_KEY=<REDACTED>");
    expect(text).not.toContain("super-secret-value");
    expect(text.length).toBeLessThanOrEqual(160);
    expect(isToolSummary(data)).toBe(true);
    expect(input.command).toBe(original);
  });

  it("preserves operation flags when paths and patterns are long", () => {
    const input = {
      path: "x".repeat(200),
      recursive: true,
      glob: "y".repeat(200),
      include_hidden: true,
    };
    const data = describeToolCall("find_files", input);
    const text = formatToolSummary(data, i18n.getFixedT("en", "ai"));
    expect(text).toContain("Recursive search");
    expect(text).toContain("Include hidden");
    expect(text).toContain("y");
    expect(text.length).toBeLessThanOrEqual(160);
    expect(isToolSummary(data)).toBe(true);
  });
});
