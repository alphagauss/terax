/**
 * 本文件验证远程工作区启动占位界面。
 * 确保 SSH 与 WSL 恢复前明确展示等待状态，而不是暴露空白初始布局。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceConnectionPlaceholder } from "@/app/components/WorkspaceConnectionPlaceholder";

vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("WorkspaceConnectionPlaceholder", () => {
  it("shows SSH connection progress before restoring saved state", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceConnectionPlaceholder kind="ssh" />,
    );

    expect(markup).toContain('data-testid="spinner"');
    expect(markup).toContain("remoteWorkspace.connecting");
    expect(markup).toContain("remoteWorkspace.restoreAfterConnection");
  });

  it("shows WSL startup progress before restoring saved state", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceConnectionPlaceholder kind="wsl" />,
    );

    expect(markup).toContain('data-testid="spinner"');
    expect(markup).toContain("remoteWorkspace.startingWsl");
    expect(markup).toContain("remoteWorkspace.restoreAfterConnection");
  });
});
