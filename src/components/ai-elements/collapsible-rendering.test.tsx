/**
 * 本文件验证工具详情的默认折叠和按需渲染行为。
 * 测试锁定完成态关闭时不生成详情 DOM 的不变量。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Tool } from "./tool";

describe("AI collapsible details", () => {
  it("keeps completed tool output unmounted until explicitly opened", () => {
    const props = {
      toolName: "find_files",
      state: "output-available" as const,
      input: { path: "/workspace" },
      output: {
        entries: [{ rel: "lazy-detail.txt", kind: "file" }],
      },
    };

    const closed = renderToStaticMarkup(<Tool {...props} />);
    const open = renderToStaticMarkup(<Tool {...props} defaultOpen />);

    expect(closed).toContain("Find");
    expect(closed).not.toContain("lazy-detail.txt");
    expect(open).toContain("lazy-detail.txt");
  });

  it("keeps error details folded by default", () => {
    const closed = renderToStaticMarkup(
      <Tool
        toolName="shell_exec"
        state="output-error"
        errorText="private-error-detail"
      />,
    );

    expect(closed).toContain("failed");
    expect(closed).not.toContain("private-error-detail");
  });

  it("renders the unified Shell process identity when expanded", () => {
    const markup = renderToStaticMarkup(
      <Tool
        toolName="shell_exec"
        state="output-available"
        input={{ command: "pnpm dev" }}
        output={{
          process_id: "00000000-0000-4000-8000-000000000002",
          status: "running",
          stdout: "ready",
          stderr: "",
        }}
        defaultOpen
      />,
    );

    expect(markup).toContain("pnpm dev");
    expect(markup).toContain("00000000-0000-4000-8000-000000000002");
    expect(markup).toContain("ready");
  });

  it("shows both paths for a structural file operation", () => {
    const markup = renderToStaticMarkup(
      <Tool
        toolName="file_operation"
        state="approval-requested"
        input={{
          operation: "move",
          path: "old.txt",
          destination: "archive/new.txt",
        }}
        defaultOpen
      />,
    );

    expect(markup).toContain("old.txt");
    expect(markup).toContain("archive/new.txt");
  });
});
