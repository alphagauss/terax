import { describe, expect, it, vi } from "vitest";
import { prepareWorkspaceBoot } from "./useSpacesBoot";

describe("prepareWorkspaceBoot", () => {
  it("finishes remote environment initialization before loading Space state", async () => {
    const order: string[] = [];
    const initialize = vi.fn(async () => {
      order.push("environment");
      return "/home/remote";
    });
    const load = vi.fn(async () => {
      order.push("spaces");
      return { spaces: [] };
    });

    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      null,
      initialize,
      load,
    );

    expect(order).toEqual(["environment", "spaces"]);
    expect(prepared?.resolvedHome).toBe("/home/remote");
  });

  it("does not load or warm remote state when home resolution fails", async () => {
    const load = vi.fn(async () => ({ spaces: [] }));

    const prepared = await prepareWorkspaceBoot(
      { kind: "wsl", distro: "Ubuntu" },
      null,
      async () => null,
      load,
    );

    expect(prepared).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("reuses a home resolved by an interactive retry", async () => {
    const initialize = vi.fn(async () => "/unused");
    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      "/srv/work",
      initialize,
      async () => "loaded",
    );

    expect(initialize).not.toHaveBeenCalled();
    expect(prepared).toEqual({ resolvedHome: "/srv/work", loaded: "loaded" });
  });
});
