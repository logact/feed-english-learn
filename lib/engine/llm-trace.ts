// LLM 调用追踪：在 LLMClient.complete 层包装（引擎唯一 chokepoint），每次调用双写 —
// SQLite llm_calls 表（按用户查询 / debug 页展示）+ pino 结构化日志文件（运维 grep/采集）。
// 重试合并为一条（attempts 计数、usage 已按次累加）。日志/落库失败只 console.error，不影响主流程。
import type { Logger } from "pino";
import { getLLMLogger } from "../logger";
import type { LLMClient, LLMRequest, LLMResult, TokenUsage } from "./llm";
import { LLMValidationError } from "./llm";
import type { Storage } from "./storage";

// 常见模型单价（美元 / 1M token）；自建兼容端点模型名任意，
// 可用 LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK 覆盖
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "mock-heuristic": { input: 0, output: 0 },
};

function envPrice(): { input: number; output: number } | null {
  const input = parseFloat(process.env.LLM_PRICE_INPUT_PER_MTOK ?? "");
  const output = parseFloat(process.env.LLM_PRICE_OUTPUT_PER_MTOK ?? "");
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}

/** 由 token 数 × 单价表估算成本（美元）；未知模型或无 usage 返回 null */
export function estimateCostUsd(model: string, usage: TokenUsage | null): number | null {
  if (!usage) return null;
  const price = envPrice() ?? MODEL_PRICES[model];
  if (!price) return null;
  return (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
}

// 已包装的客户端不再重复包装（replay 会把 traced 客户端传进新引擎）
const tracedClients = new WeakSet<LLMClient>();

export function isLLMTraced(client: LLMClient): boolean {
  return tracedClients.has(client);
}

export interface WithLLMTracingOptions {
  /** 默认用全局 llm_call logger；测试注入写临时文件的实例 */
  logger?: Logger;
}

export function withLLMTracing(
  inner: LLMClient,
  storage: Storage,
  opts: WithLLMTracingOptions = {},
): LLMClient {
  const log = opts.logger ?? getLLMLogger();

  function record(req: LLMRequest<unknown>, outcome: {
    status: "ok" | "error";
    result?: LLMResult<unknown>;
    error?: unknown;
    latencyMs: number;
  }): void {
    const usage = outcome.result?.usage ?? null;
    const model = outcome.result?.model ?? inner.modelName();
    const row = {
      userId: req.trace?.userId ?? null,
      sessionId: req.trace?.sessionId ?? null,
      scale: req.trace?.scale ?? "unknown",
      schemaName: req.schemaName,
      promptVersion: req.trace?.promptVersion ?? null,
      turn: req.trace?.turn ?? null,
      model,
      messages: JSON.stringify(req.messages),
      rawResponse: outcome.result?.raw ?? null,
      status: outcome.status,
      error:
        outcome.error === undefined
          ? null
          : outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error),
      attempts:
        outcome.result?.attempts ??
        (outcome.error instanceof LLMValidationError ? outcome.error.attempts : null),
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      latencyMs: outcome.latencyMs,
      costUsd: estimateCostUsd(model, usage),
      createdAt: new Date().toISOString(),
    };
    try {
      storage.insertLLMCall(row);
    } catch (e) {
      console.error("[llm-trace] insertLLMCall failed:", e);
    }
    try {
      const logRow = { ...row, messages: req.messages };
      if (outcome.status === "ok") log.info(logRow, "llm_call ok");
      else log.error(logRow, "llm_call error");
    } catch (e) {
      console.error("[llm-trace] pino log failed:", e);
    }
  }

  const wrapped: LLMClient = {
    modelName: () => inner.modelName(),
    async complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
      const started = performance.now();
      try {
        const result = await inner.complete(req);
        record(req, { status: "ok", result, latencyMs: Math.round(performance.now() - started) });
        return result;
      } catch (e) {
        record(req, { status: "error", error: e, latencyMs: Math.round(performance.now() - started) });
        throw e;
      }
    },
  };
  tracedClients.add(wrapped);
  return wrapped;
}
