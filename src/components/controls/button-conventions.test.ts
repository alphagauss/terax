/** 防止公共 ghost 的常规配色再次散落到业务按钮；保留业务专用效果的扩展空间。 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const repeatedColors = new Set([
  "text-muted-foreground",
  "hover:text-foreground",
  "aria-expanded:text-foreground",
  "hover:bg-accent",
  "hover:bg-muted",
  "aria-expanded:bg-muted",
  "text-destructive",
  "hover:text-destructive",
  "aria-expanded:text-destructive",
  "text-amber-600",
  "hover:text-amber-700",
  "dark:text-amber-400",
  "dark:hover:text-amber-300",
]);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["ui", "ai-elements"].includes(entry.name)
        ? []
        : sourceFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
      ? [path]
      : [];
  });
}
function literals(node: ts.Node): string[] {
  const values: string[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child))
      values.push(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return values;
}

it("业务 ghost 按钮复用公共普通、警示和危险配色", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const buttons = new Set<string>();
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@/components/controls/button"
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements)
          if ((binding.propertyName ?? binding.name).text === "Button")
            buttons.add(binding.name.text);
    }
    if (!buttons.size) continue;
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        buttons.has(node.tagName.getText(ast))
      ) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const variant = attributes.find(
          (attribute) => attribute.name.getText(ast) === "variant",
        );
        const style = attributes.find(
          (attribute) => attribute.name.getText(ast) === "className",
        );
        if (
          variant &&
          style &&
          literals(variant).some((value) => value.startsWith("ghost"))
        ) {
          const duplicates = literals(style)
            .flatMap((value) => value.split(/\s+/))
              .filter((token) => repeatedColors.has(token.replace(/!/g, "")));
          if (duplicates.length)
            violations.push(
              `${relative(sourceRoot, file)}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${duplicates.join(" ")}`,
            );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  expect(violations).toEqual([]);
});
