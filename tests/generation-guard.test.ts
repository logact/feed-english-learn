import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireGenerationLock,
  checkGenerationQuota,
  GENERATE_COOLDOWN_MS,
  GENERATE_DAILY_LIMIT,
  GENERATE_SCALE,
} from "../lib/generation-guard";
import { createStorage, type Storage } from "../lib/engine/storage";

let storage: Storage;

beforeEach(() => {
  storage = createStorage(":memory:");
});

afterEach(() => {
  storage.close();
});

const NOW = new Date("2026-10-22T12:00:00.000Z");
const USER = "u1";

function recordGeneration(userId: string, at: Date): void {
  storage.insertJournal({
    userId,
    scale: GENERATE_SCALE,
    promptVersion: "v1",
    model: "test-model",
    inputSummary: "test",
    rawResponse: "{}",
    delta: {},
    usage: null,
    createdAt: at.toISOString(),
  });
}

describe("生成配额", () => {
  it("无生成历史时放行", () => {
    expect(checkGenerationQuota(storage, USER, NOW)).toEqual({ ok: true });
  });

  it("冷却期内拒绝并给出剩余秒数", () => {
    recordGeneration(USER, new Date(NOW.getTime() - 30_000)); // 30 秒前
    const verdict = checkGenerationQuota(storage, USER, NOW);
    expect(verdict).toEqual({
      ok: false,
      reason: "cooldown",
      retryAfterSeconds: GENERATE_COOLDOWN_MS / 1000 - 30,
    });
  });

  it("冷却刚好到期时放行", () => {
    recordGeneration(USER, new Date(NOW.getTime() - GENERATE_COOLDOWN_MS));
    expect(checkGenerationQuota(storage, USER, NOW)).toEqual({ ok: true });
  });

  it("24 小时内达到每日配额时拒绝", () => {
    for (let i = 0; i < GENERATE_DAILY_LIMIT; i++) {
      recordGeneration(USER, new Date(NOW.getTime() - (i + 2) * 3_600_000));
    }
    const verdict = checkGenerationQuota(storage, USER, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("daily_quota");
  });

  it("24 小时窗口外的记录不计入配额", () => {
    for (let i = 0; i < GENERATE_DAILY_LIMIT; i++) {
      recordGeneration(USER, new Date(NOW.getTime() - 25 * 3_600_000 - i * 60_000));
    }
    expect(checkGenerationQuota(storage, USER, NOW)).toEqual({ ok: true });
  });

  it("其他用户的生成不影响本用户", () => {
    recordGeneration("u2", new Date(NOW.getTime() - 1_000));
    expect(checkGenerationQuota(storage, USER, NOW)).toEqual({ ok: true });
  });
});

describe("并发互斥锁", () => {
  it("同用户二次获取返回 null，释放后可再获取", () => {
    const release = acquireGenerationLock(USER);
    expect(release).not.toBeNull();
    expect(acquireGenerationLock(USER)).toBeNull();
    release!();
    const again = acquireGenerationLock(USER);
    expect(again).not.toBeNull();
    again!();
  });

  it("不同用户互不影响", () => {
    const release = acquireGenerationLock(USER);
    const other = acquireGenerationLock("u2");
    expect(other).not.toBeNull();
    release!();
    other!();
  });
});
