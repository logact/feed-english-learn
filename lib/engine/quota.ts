// 每日 token 限额:每用户(DAILY_TOKEN_LIMIT,默认 100k)+ 系统级(SYSTEM_DAILY_TOKEN_LIMIT,默认不限)。
// 用量从 update_journal.usage 按 UTC 日汇总,LLM 调用前检查,超限抛 TokenQuotaExceededError。
// 检查与执行之间存在并发窗口,日粒度下允许轻微超额。
import type { LLMClient, LLMRequest, LLMResult } from "./llm";
import type { Storage } from "./storage";

export class TokenQuotaExceededError extends Error {
  constructor(
    public readonly scope: "user" | "system",
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(
      scope === "user"
        ? `用户当日 token 用量 ${used} 已达上限 ${limit}`
        : `系统当日 token 用量 ${used} 已达上限 ${limit}`,
    );
    this.name = "TokenQuotaExceededError";
  }
}

export interface DailyLimits {
  user: number;
  system: number;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 0 或负数表示不限制 */
export function dailyLimits(): DailyLimits {
  return {
    user: parseLimit(process.env.DAILY_TOKEN_LIMIT, 100_000),
    system: parseLimit(process.env.SYSTEM_DAILY_TOKEN_LIMIT, 0),
  };
}

export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export function withTokenQuota(llm: LLMClient, storage: Storage, userId: string): LLMClient {
  return {
    modelName: () => llm.modelName(),
    async complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
      const limits = dailyLimits();
      const dayStart = utcDayStart();
      if (limits.user > 0) {
        const used = storage.sumTokensSince(userId, dayStart);
        if (used >= limits.user) throw new TokenQuotaExceededError("user", limits.user, used);
      }
      if (limits.system > 0) {
        const used = storage.sumTokensSince(null, dayStart);
        if (used >= limits.system) throw new TokenQuotaExceededError("system", limits.system, used);
      }
      return llm.complete(req);
    },
  };
}
