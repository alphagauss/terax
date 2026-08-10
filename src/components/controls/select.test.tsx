/**
 * 本文件验证项目级 Select 包装组件的统一焦点反馈和覆盖能力。
 * 测试锁定默认无高亮边框与光晕，同时允许业务场景显式覆盖样式。
 */

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { SelectTrigger } from "./select";

function classNameOf(node: ReactNode): string {
  if (!isValidElement<{ className?: string }>(node)) {
    throw new Error("expected a React element");
  }
  return node.props.className ?? "";
}

describe("project Select defaults", () => {
  it("removes the default focus border and ring", () => {
    const className = classNameOf(SelectTrigger({}));
    expect(className).toContain("focus-visible:border-transparent");
    expect(className).toContain("focus-visible:ring-0");
  });

  it("allows specialized controls to override the focus treatment", () => {
    const className = classNameOf(
      SelectTrigger({ className: "focus-visible:border-ring" }),
    );
    expect(className).toContain("focus-visible:border-ring");
    expect(className).not.toContain("focus-visible:border-transparent");
  });
});
