// @vitest-environment happy-dom
import { FileActionItems } from "@/modules/file-actions/FileActionItems";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ kind: "local" }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: mocks.kind }),
}));
vi.mock("@/components/menu/context-menu", () => ({
  ContextMenuSeparator: () => <hr />,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
describe("shared file menu capabilities", () => {
  it.each(["local", "wsl", "ssh"])(
    "offers new Space as the first directory action in %s",
    (kind) => {
      mocks.kind = kind;
      const html = renderToStaticMarkup(
        <FileActionItems
          target={{ path: "/project", isDir: true }}
          onOpen={vi.fn()}
          onOpenDirectory={vi.fn()}
        />,
      );
      expect(html).toMatch(/^<button[^>]*>spaces:openInNewSpace<\/button>/);
      expect(html).not.toContain("fileActions.openDirectory");
    },
  );
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
      expect(html).not.toContain("explorer:menu.copyRelativePath");
      for (const name of ["openWith", "reveal"])
        expect(html.includes(`fileActions.${name}`)).toBe(kind === "local");
    },
  );
  it.each(["local", "ssh", "wsl"])(
    "keeps path copies adjacent after opening actions in %s",
    (kind) => {
      mocks.kind = kind;
      for (const isDir of [false, true]) {
        const html = renderToStaticMarkup(
          <FileActionItems
            target={{ path: "/project/item", isDir }}
            onCopyRelativePath={vi.fn()}
            onOpen={vi.fn()}
            onOpenDirectory={vi.fn()}
            onOpenTerminal={vi.fn()}
          />,
        );
        const menu = document.createElement("div");
        menu.innerHTML = html;
        expect(Array.from(menu.children, (item) => item.textContent)).toEqual([
          isDir ? "spaces:openInNewSpace" : "fileActions.open",
          ...(kind === "local" && !isDir ? ["fileActions.openWith"] : []),
          ...(kind === "local" ? ["fileActions.reveal"] : []),
          ...(isDir ? ["explorer:menu.openInTerminal"] : []),
          "",
          "fileActions.copyPath",
          "explorer:menu.copyRelativePath",
          ...(!isDir
            ? ["fileActions.copyContent", "", "fileActions.saveAs"]
            : []),
        ]);
      }
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
