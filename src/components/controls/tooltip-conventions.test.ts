/** 防止业务界面重新引入浏览器原生提示；组件的业务标题和 iframe 可访问标题不受影响。 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["ui", "ai-elements"].includes(entry.name)) return [];
      return sourceFiles(path);
    }
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
      ? [path]
      : [];
  });
}

it("uses shared hints instead of native title attributes in owned UI", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast);
        if (
          tag !== "iframe" &&
          (/^[a-z]/.test(tag) || ["Button", "SelectTrigger"].includes(tag))
        ) {
          for (const attribute of node.attributes.properties) {
            if (
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(ast) === "title"
            ) {
              const line =
                ast.getLineAndCharacterOfPosition(attribute.getStart()).line +
                1;
              violations.push(`${relative(sourceRoot, file)}:${line}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(violations).toEqual([]);
});
