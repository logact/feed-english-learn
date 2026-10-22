// 材料生成的成本守卫：冷却期 + 每日配额（基于 update_journal 的 scale="generate" 记录，
// 失败尝试也计入——失败同样花了 LLM 调用）+ 同用户并发互斥锁。
// 不依赖 Next.js，可在 vitest 中独立使用。
import type { Storage } from "./engine/storage";

export const GENERATE_SCALE = "generate";

export const GENERATE_COOLDOWN_MS =
  Number(process.env.MATERIALS_COOLDOWN_SECONDS ?? 60) * 1000;
export const GENERATE_DAILY_LIMIT = Number(process.env.MATERIALS_DAILY_QUOTA ?? 20);
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type QuotaVerdict =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "daily_quota"; retryAfterSeconds: number };

export function checkGenerationQuota(
  storage: Storage,
  userId: string,
  now: Date = new Date(),
): QuotaVerdict {
  const sinceIso = new Date(now.getTime() - DAILY_WINDOW_MS).toISOString();
  const recentCount = storage.countJournalSince(userId, GENERATE_SCALE, sinceIso);
  if (recentCount >= GENERATE_DAILY_LIMIT) {
    return { ok: false, reason: "daily_quota", retryAfterSeconds: DAILY_WINDOW_MS / 1000 };
  }

  const lastTs = storage.lastJournalTs(userId, GENERATE_SCALE);
  if (lastTs) {
    const elapsedMs = now.getTime() - new Date(lastTs).getTime();
    if (elapsedMs < GENERATE_COOLDOWN_MS) {
      return {
        ok: false,
        reason: "cooldown",
        retryAfterSeconds: Math.ceil((GENERATE_COOLDOWN_MS - elapsedMs) / 1000),
      };
    }
  }
  return { ok: true };
}

// 进程内互斥锁（HMR 安全，仿照 getDefaultStorage 的 globalThis 单例）。
// 当前 PM2 单进程部署够用；水平扩容时需换 DB 锁实现。
const globalLocks = globalThis as unknown as { __generationLocks?: Set<string> };

export function acquireGenerationLock(userId: string): (() => void) | null {
  globalLocks.__generationLocks ??= new Set();
  const locks = globalLocks.__generationLocks;
  if (locks.has(userId)) return null;
  locks.add(userId);
  return () => {
    locks.delete(userId);
  };
}
