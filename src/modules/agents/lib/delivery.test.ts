/**
 * 本文件测试 Agent 通知的渠道选择。
 * 锁定前台可见时静默、后台使用系统通知及安静更新只进入通知栏的规则。
 */

import { describe, expect, it } from "vitest";
import { resolveAgentNotificationDelivery } from "./delivery";

describe("resolveAgentNotificationDelivery", () => {
  it("用户正在查看对应 Agent 时保持静默", () => {
    expect(
      resolveAgentNotificationDelivery({
        focused: true,
        visible: true,
        allowToast: true,
      }),
    ).toBe("none");
  });

  it("窗口未聚焦时使用系统通知", () => {
    expect(
      resolveAgentNotificationDelivery({
        focused: false,
        visible: false,
        allowToast: true,
      }),
    ).toBe("native");
  });

  it("窗口聚焦但 Agent 不可见时允许应用内提示", () => {
    expect(
      resolveAgentNotificationDelivery({
        focused: true,
        visible: false,
        allowToast: true,
      }),
    ).toBe("toast");
  });

  it("安静更新只写入通知栏", () => {
    expect(
      resolveAgentNotificationDelivery({
        focused: true,
        visible: false,
        allowToast: false,
      }),
    ).toBe("bell");
  });
});
