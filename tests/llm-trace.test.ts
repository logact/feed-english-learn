import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  MockLLMClient,
  type LLMClient,
  type LLMResult,
} from "../lib/engine/llm";
import { estimateCostUsd, withLLMTracing } from "../lib/engine/llm-trace";
import { createStorage, type Storage } from "../lib/engine/storage";
import { createEngine } from "../lib/engine/engine";
import { createFileLogger } from "../lib/logger";
import { ProfileSessionUpdateSchema } from "../contracts/profile";

const SimpleSchema = z.object({ ok: z.boolean() });

describe("estimateCostUsd", () => {
  afterEach(() => {
    delete process.env.LLM_PRICE_INPUT_PER_MTOK;
    delete process.env.LLM_PRICE_OUTPUT_PER_MTOK;
  });

  it("已知模型命中内置价格表", () => {
    const cost = estimateCostUsd("gpt-4o-mini", { promptTokens: 1000, completionTokens: 1000 });
    expect(cost).toBeCloseTo(0.00075, 8);
  });

  it("未知模型返回 null", () => {
    expect(estimateCostUsd("some-custom-model", { promptTokens: 100, completionTokens: 50 })).toBeNull();
  });

  it("usage 为 null 时返回 null", () => {
    expect(estimateCostUsd("gpt-4o-mini", null)).toBeNull();
  });

  it("env 单价覆盖对任意模型名生效", () => {
    process.env.LLM_PRICE_INPUT_PER_MTOK = "1";
    process.env.LLM_PRICE_OUTPUT_PER_MTOK = "2";
    const cost = estimateCostUsd("some-custom-model", { promptTokens: 1_000_000, completionTokens: 500_000 });
    expect(cost).toBeCloseTo(2, 8);
  });
});

describe("withLLMTracing", () => {
  const userId = "u1";
  let storage: Storage;
  let tmp: string;
  let logFile: string;

  beforeEach(() => {
    storage = createStorage(":memory:");
    tmp = mkdtempSync(join(tmpdir(), "llm-trace-"));
    logFile = join(tmp, "llm.jsonl");
  });

  afterEach(() => {
    storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function readLogLines(): Record<string, unknown>[] {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("成功路径：llm_calls 落库一行且 trace 字段正确，pino JSONL 同步记录", async () => {
    const logger = createFileLogger(logFile, { component: "llm_call" });
    const llm = withLLMTracing(new MockLLMClient(), storage, { logger });
    const r = await llm.complete({
      schemaName: "ProfileSessionUpdate",
      schema: ProfileSessionUpdateSchema,
      messages: [{ role: "user", content: "hi" }],
      trace: { userId, sessionId: "s1", scale: "session", promptVersion: "update_profile@v1" },
    });
    expect(r.model).toBe("mock-heuristic");

    const rows = storage.listLLMCalls(userId);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.sessionId).toBe("s1");
    expect(row.scale).toBe("session");
    expect(row.promptVersion).toBe("update_profile@v1");
    expect(row.schemaName).toBe("ProfileSessionUpdate");
    expect(row.status).toBe("ok");
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(row.messages)[0].content).toBe("hi");
    expect(row.rawResponse).toBe(r.raw);

    const lines = readLogLines();
    expect(lines.length).toBe(1);
    expect(lines[0].component).toBe("llm_call");
    expect(lines[0].schemaName).toBe("ProfileSessionUpdate");
    expect(lines[0].status).toBe("ok");
    expect(lines[0].userId).toBe(userId);
  });

  it("错误路径：记录 error 行（双写）且异常照常抛出", async () => {
    const failing: LLMClient = {
      modelName: () => "failing-model",
      async complete<T>(): Promise<LLMResult<T>> {
        throw new Error("boom");
      },
    };
    const logger = createFileLogger(logFile, { component: "llm_call" });
    const llm = withLLMTracing(failing, storage, { logger });
    await expect(
      llm.complete({
        schemaName: "S",
        schema: SimpleSchema,
        messages: [],
        trace: { userId, scale: "generate", turn: 2 },
      }),
    ).rejects.toThrow("boom");

    const rows = storage.listLLMCalls(userId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toBe("boom");
    expect(rows[0].rawResponse).toBeNull();
    expect(rows[0].model).toBe("failing-model");
    expect(rows[0].turn).toBe(2);

    const lines = readLogLines();
    expect(lines.length).toBe(1);
    expect(lines[0].status).toBe("error");
    expect(lines[0].error).toBe("boom");
  });

  it("落库失败不影响主流程", async () => {
    const closed = createStorage(":memory:");
    closed.close();
    const logger = createFileLogger(logFile, { component: "llm_call" });
    const llm = withLLMTracing(new MockLLMClient(), closed, { logger });
    const r = await llm.complete({ schemaName: "ProfileSessionUpdate", schema: ProfileSessionUpdateSchema, messages: [] });
    expect(r.model).toBe("mock-heuristic");
  });

  it("生成器链路：每个 turn 一条记录且 turn 递增", async () => {
    const logger = createFileLogger(logFile, { component: "llm_call" });
    // 手动包装后注入引擎（WeakSet 防重复包装），这样日志写临时文件而非全局单例
    const llm = withLLMTracing(new MockLLMClient(), storage, { logger });
    const engine = createEngine({ storage, llm });
    const result = await engine.generateMaterial(userId, {
      now: "2026-01-01T10:00:00.000Z",
      materialId: "m-trace-1",
    });
    expect(result.report.pass).toBe(true);

    const rows = storage.listLLMCalls(userId);
    expect(rows.length).toBe(result.turns);
    expect(rows.map((r) => r.turn)).toEqual(rows.map((_, i) => i + 1));
    for (const row of rows) {
      expect(row.scale).toBe("generate");
      expect(row.promptVersion).toBe("generate_material@v1");
      expect(row.schemaName).toBe("GeneratorTurn");
      expect(row.status).toBe("ok");
    }
    expect(readLogLines().length).toBe(result.turns);
  });
});
