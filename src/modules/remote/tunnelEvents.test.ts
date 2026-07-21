import { describe, expect, it } from "vitest";
import { applyTunnelEvent } from "./tunnelEvents";
import type { TunnelInfo } from "./types";

const tunnel = (id: number, name: string): TunnelInfo => ({
  id,
  profileId: "profile-1",
  name,
  kind: "local",
  status: "active",
  bindHost: "127.0.0.1",
  bindPort: 3000 + id,
  requestedBindPort: 3000 + id,
  targetHost: "localhost",
  targetPort: 4000 + id,
  bytes: 0,
});

describe("applyTunnelEvent", () => {
  it("keeps a restored tunnel visible after an update failure", () => {
    const other = tunnel(2, "other");
    const restored = tunnel(1, "restored original");
    const afterFailure = applyTunnelEvent([tunnel(1, "replacement"), other], {
      kind: "failed",
      profileId: "profile-1",
      tunnel: restored,
      message: "replacement failed; the previous tunnel was restored",
    });

    expect(afterFailure).toEqual([restored, other]);
    expect(
      applyTunnelEvent(afterFailure, {
        kind: "stopped",
        profileId: "profile-1",
        tunnel: { ...restored, status: "closed" },
      }),
    ).toEqual([other]);
  });
});
