/**
 * 本文件验证远程工作区连接占位界面。
 * 确保工作区恢复前明确展示连接等待状态，而不是暴露空白初始布局。
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
  it("shows that saved workspace state will be restored after connection", () => {
    const markup = renderToStaticMarkup(<WorkspaceConnectionPlaceholder />);

    expect(markup).toContain('data-testid="spinner"');
    expect(markup).toContain("remoteWorkspace.connecting");
    expect(markup).toContain("remoteWorkspace.restoreAfterConnection");
  });
});
