// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeliveryCard } from "@/modules/channels/components/DeliveryCard";
import {
  useDeliveryHistory,
  type DeliveryDisplay,
} from "@/modules/channels/history";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: unknown) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: "en" },
  }),
}));
const entry: DeliveryDisplay = {
  id: "delivery",
  phase: "request",
  source: "application",
  timestamp: 0,
  target: { kind: "direct", id: "owner" },
  content: { text: "hello" },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useDeliveryHistory.setState({ sessions: {}, pending: {} });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
  return container.innerHTML;
}

it("单项未确认显示检查提示与原因，不显示零个成功项或发送失败", async () => {
  const html = await render(
    <DeliveryCard
      entry={{
        ...entry,
        result: {
          status: "unknown",
          parts: [{ index: 0, status: "unknown" }],
          reason: "network",
          total: 1,
        },
      }}
    />,
  );
  expect(html).toContain("outbound.unknownHelp");
  expect(html).toContain("outbound.reasons.network");
  expect(html).not.toContain("outbound.parts");
  expect(html).not.toContain("outbound.failed");
});

it("回复回执保留异常，省略已展示正文；多项统计包含未发送项", async () => {
  const html = await render(
    <DeliveryCard
      compact
      entry={{
        ...entry,
        source: "agent",
        result: {
          status: "partial",
          parts: [
            { index: 0, status: "accepted" },
            { index: 1, status: "failed" },
          ],
          total: 3,
          reason: "upload",
        },
      }}
    />,
  );
  expect(html).not.toContain("hello");
  expect(html).toContain("outbound.sources.agent");
  expect(html).toContain("outbound.partial");
  expect(html).toContain('"unsent":1');
});

it("没有回执的历史显示未确认，发送中不显示异常", async () => {
  expect(await render(<DeliveryCard entry={entry} />)).toContain(
    "outbound.unknownHelp",
  );
  await act(async () =>
    useDeliveryHistory.setState({ pending: { delivery: true } }),
  );
  const html = await render(<DeliveryCard entry={entry} />);
  expect(html).toContain("outbound.sending");
  expect(html).not.toContain("outbound.unknownHelp");
});
