import { assert, describe, expect, it, vi } from "vitest";
import {
  bindChannelDelivery,
  getChannelMessageSender,
} from "@/modules/channels/delivery";
import type { ChannelAdapter, ChannelInbound } from "@/modules/channels/types";

const target = (id: string): ChannelInbound => ({
  id,
  senderId: id,
  text: "",
  attachments: [],
  receivedAt: 1,
  replyContext: { token: id },
});
const accepted = {
  status: "accepted" as const,
  parts: [{ index: 0, status: "accepted" as const }],
};

describe("run-scoped Channel delivery", () => {
  it("serializes a target without blocking another instance and invalidates old tool closures", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      cursorScope: "account",
      receive: async () => {},
      send: async (target, input) => {
        calls.push(`${target.senderId}:${input.text}`);
        if (input.text === "first") await blocked;
        return accepted;
      },
    };
    const signal = new AbortController().signal;
    const a = bindChannelDelivery("a", adapter, target("a"), signal);
    const b = bindChannelDelivery("b", adapter, target("b"), signal);
    const old = getChannelMessageSender("a");
    assert(old);
    const first = a.send({ text: "first" });
    const second = a.send({ text: "second" });
    await b.send({ text: "other" });
    expect(calls).toEqual(["a:first", "b:other"]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["a:first", "b:other", "a:second"]);
    await a.close();
    const next = bindChannelDelivery("a", adapter, target("new"), signal);
    await expect(old({ text: "late" })).rejects.toThrow("cancelled");
    expect(getChannelMessageSender("a")).not.toBe(old);
    await next.close();
    await b.close();
  });

  it("preserves partial acceptance and refuses dispatch after cancellation", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => ({
      status: "unknown" as const,
      parts: [
        { index: 0, status: "accepted" as const },
        { index: 1, status: "unknown" as const },
      ],
    }));
    const delivery = bindChannelDelivery(
      "partial",
      { cursorScope: "x", receive: async () => {}, send },
      target("x"),
      controller.signal,
    );
    expect((await delivery.send({ text: "parts" })).status).toBe("unknown");
    expect(delivery.accepted).toBe(true);
    expect(delivery.failed).toBe(true);
    controller.abort();
    await expect(delivery.send({ text: "late" })).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    await delivery.close();
  });
});
