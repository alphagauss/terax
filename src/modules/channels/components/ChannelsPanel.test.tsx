import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChannelsPanel } from "@/modules/channels/components/ChannelsPanel";
import {
  useChannelsView,
  useChannelSelection,
} from "@/modules/channels/client";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: (select: (state: { sessions: [] }) => unknown) =>
    select({ sessions: [] }),
}));
vi.mock("@/modules/ai/lib/sessions", () => ({ readSession: vi.fn() }));
vi.mock("@/modules/ai/lib/conversation", () => ({
  messageMetadata: vi.fn(),
  projectSessionMessages: vi.fn(),
}));

it("没有实例或对话时，首次打开与恢复消息面板都能渲染空状态", () => {
  useChannelsView.setState({ snapshots: [] });
  useChannelSelection.setState({ connectionId: "previous-selection" });
  expect(renderToString(<ChannelsPanel visible={false} />)).toContain(
    "outbound.noTarget",
  );
  expect(renderToString(<ChannelsPanel visible />)).toContain(
    "outbound.noTarget",
  );
  useChannelsView.setState({
    snapshots: [
      {
        connection: {
          id: "instance",
          kind: "weixin",
          name: "WeChat",
          accountId: null,
          enabled: false,
          busyMessageMode: "queue",
        },
        status: "disabled",
        issue: null,
        busy: false,
        queued: 0,
        conversations: [],
      },
    ],
  });
  expect(renderToString(<ChannelsPanel visible />)).toContain(
    "outbound.noTarget",
  );
});
