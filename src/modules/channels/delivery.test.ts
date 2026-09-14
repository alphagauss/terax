import { assert, describe, expect, it, vi } from "vitest";
import {
  bindChannelDelivery,
  getChannelMessageSender,
} from "@/modules/channels/delivery";
import type { ChannelAdapter, ChannelTarget } from "@/modules/channels/types";

const target = (id: string): ChannelTarget => ({ kind: "direct", id });
const accepted = {
  status: "accepted" as const,
  parts: [{ index: 0, status: "accepted" as const }],
};

describe("run-scoped Channel delivery", () => {
  it("binds targets independently and invalidates old tool closures", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const send: ChannelAdapter["send"] = async (target, input) => {
      calls.push(`${target.id}:${input.text}`);
      if (input.text === "first") await blocked;
      return accepted;
    };
    const signal = new AbortController().signal;
    const a = bindChannelDelivery("a", send, target("a"), signal);
    const b = bindChannelDelivery("b", send, target("b"), signal);
    const old = getChannelMessageSender("a");
    assert(old);
    const first = a.send({ text: "first" });
    const second = a.send({ text: "second" });
    await b.send({ text: "other" });
    expect(calls).toEqual(["a:first", "a:second", "b:other"]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["a:first", "a:second", "b:other"]);
    await a.close();
    const next = bindChannelDelivery("a", send, target("new"), signal);
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
      send,
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
