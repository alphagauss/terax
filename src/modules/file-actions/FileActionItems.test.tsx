// @vitest-environment happy-dom
import { FileActionItems } from "@/modules/file-actions/FileActionItems";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ kind: "local" }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: mocks.kind }),
}));
vi.mock("@/components/menu/context-menu", () => ({
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
describe("shared file menu capabilities", () => {
  it.each(["local", "ssh", "wsl"])(
    "limits %s menus to supported operations",
    (kind) => {
      mocks.kind = kind;
      const html = renderToStaticMarkup(
        <FileActionItems
          target={{ path: "/tmp/file", isDir: false }}
          onOpen={vi.fn()}
        />,
      );
      for (const name of ["open", "saveAs", "copyPath", "copyContent"])
        expect(html).toContain(`fileActions.${name}`);
      for (const name of ["openWith", "reveal"])
        expect(html.includes(`fileActions.${name}`)).toBe(kind === "local");
    },
  );
  it("hides content and export actions for directories", () => {
    mocks.kind = "local";
    const html = renderToStaticMarkup(
      <FileActionItems
        target={{ path: "/tmp", isDir: true }}
        onOpen={vi.fn()}
      />,
    );
    expect(html).toContain("fileActions.openDirectory");
    for (const name of ["saveAs", "copyContent", "openWith"])
      expect(html).not.toContain(`fileActions.${name}`);
  });
});
