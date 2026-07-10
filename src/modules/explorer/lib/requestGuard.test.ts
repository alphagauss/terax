import { describe, expect, it } from "vitest";
import { isCurrentTreeRequest } from "./requestGuard";

describe("isCurrentTreeRequest", () => {
  const request = { scope: "ssh:prod\0/home/me", generation: 3, id: 7 };

  it("accepts only the latest request in the active workspace tree", () => {
    expect(isCurrentTreeRequest(request, request.scope, 3, 7)).toBe(true);
    expect(isCurrentTreeRequest(request, "local\0/home/me", 3, 7)).toBe(
      false,
    );
    expect(isCurrentTreeRequest(request, request.scope, 4, 7)).toBe(false);
    expect(isCurrentTreeRequest(request, request.scope, 3, 8)).toBe(false);
  });
});
