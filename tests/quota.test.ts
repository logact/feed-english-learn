import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { createStorage, type Storage } from "../lib/engine/storage";
import type { LLMClient, LLMResult } from "../lib/engine/llm";
import {
  withTokenQuota,
  TokenQuotaExceededError,
  utcDayStart,
} from "../lib/engine/quota";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env.DAILY_TOKEN_LIMIT = savedEnv.DAILY_TOKEN_LIMIT;
  process.env.SYSTEM_DAILY_TOKEN_LIMIT = savedEnv.SYSTEM_DAILY_TOKEN_LIMIT;
});

function journal(
  storage: Storage,
  userId: string,
  usage: { promptTokens: number; completionTokens: number } | null,
  createdAt: string = new Date().toISOString(),
) {
  storage.insertJournal({
    userId,
    scale: "session",
    promptVersion: "v1",
    model: "test",
    inputSummary: "",
    rawResponse: "",
    delta: {},
    usage,
    createdAt,
  });
}

const echoClient: LLMClient = {
  modelName: () => "echo",
  async complete<T>(): Promise<LLMResult<T>> {
    return { data: { ok: true } as T, raw: "{}", attempts: 1, usage: null, model: "echo" };
  },
};

const req = { schemaName: "Test", schema: z.object({ ok: z.boolean() }), messages: [] };

describe("sumTokensSince", () => {
  it("按用户与时间汇总,usage 为 null 计 0", () => {
    const storage = createStorage(":memory:");
    journal(storage, "u1", { promptTokens: 60, completionTokens: 40 });
    journal(storage, "u1", null);
    journal(storage, "u1", { promptTokens: 10, completionTokens: 0 }, "2020-01-01T00:00:00.000Z");
    journal(storage, "u2", { promptTokens: 5, completionTokens: 5 });

    expect(storage.sumTokensSince("u1", utcDayStart())).toBe(100);
    expect(storage.sumTokensSince(null, utcDayStart())).toBe(110);
    expect(storage.sumTokensSince("u1", "2020-01-01T00:00:00.000Z")).toBe(110);
    storage.close();
  });
});

describe("withTokenQuota", () => {
  it("未超限透传调用", async () => {
    process.env.DAILY_TOKEN_LIMIT = "1000";
    const storage = createStorage(":memory:");
    const limited = withTokenQuota(echoClient, storage, "u1");
    const result = await limited.complete(req);
    expect(result.data).toEqual({ ok: true });
    expect(limited.modelName()).toBe("echo");
    storage.close();
  });

  it("达到每用户限额抛 TokenQuotaExceededError(scope=user)", async () => {
    process.env.DAILY_TOKEN_LIMIT = "100";
    const storage = createStorage(":memory:");
    journal(storage, "u1", { promptTokens: 60, completionTokens: 40 });
    const limited = withTokenQuota(echoClient, storage, "u1");
    await expect(limited.complete(req)).rejects.toMatchObject({
      name: "TokenQuotaExceededError",
      scope: "user",
      limit: 100,
      used: 100,
    });
    storage.close();
  });

  it("达到系统限额抛 TokenQuotaExceededError(scope=system)", async () => {
    process.env.DAILY_TOKEN_LIMIT = "0"; // 关闭用户限额
    process.env.SYSTEM_DAILY_TOKEN_LIMIT = "100";
    const storage = createStorage(":memory:");
    journal(storage, "u2", { promptTokens: 80, completionTokens: 20 });
    const limited = withTokenQuota(echoClient, storage, "u1");
    await expect(limited.complete(req)).rejects.toBeInstanceOf(TokenQuotaExceededError);
    await expect(limited.complete(req)).rejects.toMatchObject({ scope: "system" });
    storage.close();
  });

  it("限额为 0 表示不限制", async () => {
    process.env.DAILY_TOKEN_LIMIT = "0";
    process.env.SYSTEM_DAILY_TOKEN_LIMIT = "0";
    const storage = createStorage(":memory:");
    journal(storage, "u1", { promptTokens: 10_000_000, completionTokens: 0 });
    const limited = withTokenQuota(echoClient, storage, "u1");
    await expect(limited.complete(req)).resolves.toBeDefined();
    storage.close();
  });
});
