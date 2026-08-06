/**
 * 本文件验证项目级菜单包装组件的默认密度和覆盖能力。
 * 测试锁定普通菜单默认紧凑，复杂菜单仍可显式替换尺寸类。
 */

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { DropdownMenuContent, DropdownMenuItem } from "./dropdown-menu";

function classNameOf(node: ReactNode): string {
  if (!isValidElement<{ className?: string }>(node)) {
    throw new Error("expected a React element");
  }
  return node.props.className ?? "";
}

describe("project menu defaults", () => {
  it("uses the compact file-explorer density by default", () => {
    expect(classNameOf(DropdownMenuContent({}))).toContain(
      "min-w-44 rounded-2xl p-1",
    );
    expect(classNameOf(DropdownMenuItem({}))).toContain(
      "gap-2 rounded-xl px-2.5 py-1.5 text-xs",
    );
  });

  it("allows specialized menus to override default layout classes", () => {
    const className = classNameOf(
      DropdownMenuContent({ className: "min-w-60 rounded-xl p-0" }),
    );
    expect(className).toContain("min-w-60 rounded-xl p-0");
    expect(className).not.toContain("min-w-44");
    expect(className).not.toContain("rounded-2xl");
    expect(className).not.toContain("p-1");
  });
});
