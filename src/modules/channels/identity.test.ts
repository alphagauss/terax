import { expect, it } from "vitest";
import { channelOwnerId, channelSessionId } from "@/modules/channels/identity";

it("账号和目标唯一决定 UUID，实例重建不变且不同账号、目标和话题隔离", async () => {
  const account = { kind: "weixin" as const, accountId: "owner" };
  const target = { kind: "group" as const, id: "room" };
  const first = await channelSessionId(account, target);
  expect(first).toBe("743f6e4c-48bb-5d8f-9a0e-a8814c7229c7");
  expect(first).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(
    await channelSessionId(
      { ...account, id: "replacement" } as typeof account,
      target,
    ),
  ).toBe(first);
  expect(await channelOwnerId(account)).not.toBe(first);
  const variants = await Promise.all([
    channelSessionId({ ...account, accountId: "another" }, target),
    channelSessionId(account, { ...target, id: "another" }),
    channelSessionId(account, { ...target, threadId: "topic" }),
    channelSessionId(account, { ...target, kind: "direct" }),
  ]);
  expect(new Set([first, ...variants]).size).toBe(5);
});
