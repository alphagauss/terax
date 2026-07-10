import { describe, expect, it } from "vitest";
import { mergeSessionMetadata, type SessionMeta } from "./sessions";

const meta = (
  id: string,
  updatedAt: number,
  fingerprint?: string,
): SessionMeta => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt,
  fingerprint,
});

describe("session metadata merge", () => {
  it("accepts external additions, updates, and deletions", () => {
    const local = [meta("updated", 2, "old"), meta("deleted", 1, "old")];
    const disk = [meta("added", 4, "new"), meta("updated", 3, "new")];
    expect(mergeSessionMetadata(local, disk, new Set())).toEqual(disk);
  });

  it("preserves a running session and an unpublished New chat", () => {
    const local = [meta("running", 5, "old"), meta("draft", 4)];
    const disk = [meta("running", 6, "external"), meta("other", 3, "new")];
    expect(
      mergeSessionMetadata(local, disk, new Set(["running"])).map(
        (session) => [session.id, session.fingerprint],
      ),
    ).toEqual([
      ["running", "old"],
      ["draft", undefined],
      ["other", "new"],
    ]);
  });
});
