import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionId } from "../lib/session-id";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSessionId", () => {
  it("安全上下文使用 randomUUID", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-session" });
    expect(createSessionId()).toBe("uuid-session");
  });

  it("randomUUID 不可用时使用 getRandomValues", () => {
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });
    expect(createSessionId()).toBe("07".repeat(16));
  });
});
