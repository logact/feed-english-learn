// 引擎门面：事件分发（尺度 1 实时确定性；尺度 2/3 按触发）+ 消费接口。
// 不依赖 Next.js，可在 tsx 脚本 / vitest 中独立使用。
import type { ReadingEvent } from "../../contracts/events";
import { defaultProfile, type UserProfile } from "../../contracts/profile";
import type { KnowledgeItem } from "../../contracts/knowledge";
import type { TargetSpec } from "../../contracts/target-spec";
import type { GeneratedMaterial } from "../../contracts/generator";
import { validateEvents } from "./ingest";
import {
  createFromKnown,
  createFromLookup,
  effectiveState,
  transition,
} from "./knowledge";
import {
  applyPendingWrites,
  computeSessionUpdate,
  emptyPendingWrites,
  type PendingWrites,
  type Tuning,
} from "./profiler";
import {
  buildTargetSpec,
  generateMaterial as runGenerateMaterial,
  type GenerateOptions,
} from "./generator";
import { createStorage, getDefaultStorage, type Storage } from "./storage";
import { createLLMClient, type LLMClient } from "./llm";

export interface EngineOptions {
  storage?: Storage;
  llm?: LLMClient;
  tuning?: Tuning;
}

export interface EventOutcome {
  type: ReadingEvent["type"];
  status: "applied" | "duplicate" | "error";
  error?: string;
}

export interface ProcessResult {
  /** 成功落库的事件数（含幂等去重跳过的重复事件） */
  processed: number;
  errors: { index: number; error: string }[];
  /** 触发了尺度 2 更新的 session 数 */
  sessionUpdates: number;
  results: EventOutcome[];
}

export interface Engine {
  storage: Storage;
  llm: LLMClient;
  processEvent(ev: ReadingEvent): Promise<{ duplicate: boolean; sessionUpdated: boolean }>;
  processEvents(body: unknown): Promise<ProcessResult>;
  getProfile(userId: string): UserProfile;
  getKnowledgeItems(userId: string): (KnowledgeItem & { effective_state: string })[];
  getTargetSpec(userId: string): TargetSpec;
  generateMaterial(userId: string, opts?: GenerateOptions): Promise<GeneratedMaterial>;
  replay(userId: string): Promise<{ replayed: UserProfile; current: UserProfile; diff: string[] }>;
}

function firstSentenceWith(text: string, lemma: string): string | undefined {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const lower = lemma.toLowerCase();
  return sentences.find((s) => s.toLowerCase().includes(lower));
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const storage = opts.storage ?? getDefaultStorage();
  const llm = opts.llm ?? createLLMClient();
  const tuning = opts.tuning ?? {};

  /** 知识事件只算不写：返回待落库的写入集，由调用方放进事务 */
  function planKnowledgeEvent(
    userId: string,
    lemmaRaw: string,
    itemType: "word" | "phrase",
    ev: Parameters<typeof transition>[1],
    sessionId: string,
    ts: string,
  ): PendingWrites {
    const writes = emptyPendingWrites();
    const lemma = lemmaRaw.toLowerCase();
    const existing = storage.getKnowledgeItem(userId, lemma);
    let result;
    if (!existing) {
      if (ev.kind === "lookup") result = createFromLookup(lemma, itemType, ev);
      else if (ev.kind === "known") result = createFromKnown(lemma, itemType, ev);
      else return writes; // 未跟踪词的纯曝光不建条目
    } else {
      result = transition(existing, ev, ts);
    }
    writes.knowledgeUpserts.push({ userId, item: result.item, updatedAt: ts });
    if (result.changed) {
      writes.knowledgeChanges.push({
        user_id: userId,
        session_id: sessionId,
        item: lemma,
        from_state: result.changed.from,
        to_state: result.changed.to,
        trigger: ev.kind === "lookup" ? "lookup" : ev.kind === "known" ? "known" : "exposure",
        note: null,
        ts,
      });
    }
    return writes;
  }

  /** session 结束时的曝光记账：材料文本中出现且本 session 未查的词（只算不写） */
  function planExposures(userId: string, sessionId: string, ts: string): PendingWrites {
    const writes = emptyPendingWrites();
    const sessionEvents = storage.listSessionEvents(userId, sessionId);
    const startEv = sessionEvents.find((e) => e.type === "session_start");
    const materialId =
      sessionEvents.find((e) => e.type === "material_completed" || e.type === "material_abandoned")
        ?.material_id ?? (startEv?.type === "session_start" ? startEv.material.material_id : null);
    if (!materialId) return writes;
    const material = storage.getMaterial(materialId);
    if (!material?.text) return writes;

    const lookedUp = new Set(
      sessionEvents.filter((e) => e.type === "word_lookup").map((e) => e.lemma.toLowerCase()),
    );
    const tokens = new Set(material.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []);
    for (const item of storage.listKnowledgeItems(userId)) {
      if (!tokens.has(item.item)) continue;
      if (lookedUp.has(item.item)) continue; // 查过：lookup 已记账
      const w = planKnowledgeEvent(
        userId,
        item.item,
        item.item_type,
        { kind: "exposure", sessionId, ts, sentence: firstSentenceWith(material.text, item.item) },
        sessionId,
        ts,
      );
      writes.knowledgeUpserts.push(...w.knowledgeUpserts);
      writes.knowledgeChanges.push(...w.knowledgeChanges);
    }
    return writes;
  }

  /** 幂等判定：客户端重试（同 event_id）或重复 session_end 直接跳过副作用 */
  function isDuplicateEvent(ev: ReadingEvent): boolean {
    if (ev.event_id && storage.hasEventId(ev.event_id)) return true;
    if (ev.type === "session_end" && storage.hasSessionEnd(ev.user_id, ev.session_id)) return true;
    return false;
  }

  async function processEvent(ev: ReadingEvent): Promise<{ duplicate: boolean; sessionUpdated: boolean }> {
    if (isDuplicateEvent(ev)) return { duplicate: true, sessionUpdated: false };

    if (ev.type === "session_end") {
      // LLM（异步）在事务外完成；事件行 + 曝光 + 尺度 2/3 全部写入在单个同步事务里落库，
      // 任一步失败整体回滚 → 路由 500 → 客户端带同一 event_id 重试是安全的
      const now = ev.ts;
      const exposureWrites = planExposures(ev.user_id, ev.session_id, now);
      const { writes } = await computeSessionUpdate(
        storage,
        llm,
        ev.user_id,
        ev.session_id,
        { now, extraChanges: exposureWrites.knowledgeChanges },
        tuning,
      );
      let applied = false;
      storage.transaction(() => {
        if (isDuplicateEvent(ev)) return; // await 期间可能已被并发请求落库
        storage.insertEvent(ev);
        applyPendingWrites(storage, exposureWrites);
        applyPendingWrites(storage, writes);
        applied = true;
      });
      return { duplicate: !applied, sessionUpdated: applied };
    }

    storage.transaction(() => {
      storage.insertEvent(ev);
      switch (ev.type) {
        case "session_start":
          storage.saveMaterial(ev.material);
          break;
        case "word_lookup":
          applyPendingWrites(
            storage,
            planKnowledgeEvent(
              ev.user_id,
              ev.lemma,
              ev.item_type,
              { kind: "lookup", sessionId: ev.session_id, ts: ev.ts, sentence: ev.sentence },
              ev.session_id,
              ev.ts,
            ),
          );
          break;
        case "word_known":
          applyPendingWrites(
            storage,
            planKnowledgeEvent(
              ev.user_id,
              ev.lemma,
              "word",
              { kind: "known", sessionId: ev.session_id, ts: ev.ts },
              ev.session_id,
              ev.ts,
            ),
          );
          break;
        case "material_completed":
        case "material_abandoned":
        case "feedback":
          break; // 计入事件流，由 digest 消费
      }
    });
    return { duplicate: false, sessionUpdated: false };
  }

  function getProfile(userId: string): UserProfile {
    return (
      storage.getProfile(userId) ??
      defaultProfile(userId, storage.lastEventTs(userId) ?? new Date().toISOString())
    );
  }

  return {
    storage,
    llm,

    processEvent,

    async processEvents(body: unknown): Promise<ProcessResult> {
      const { events, errors } = validateEvents(body);
      // 逐事件独立处理：单个失败不影响批内其他事件，逐事件状态返回给客户端
      const results: EventOutcome[] = [];
      let processed = 0;
      let sessionUpdates = 0;
      for (const ev of events) {
        try {
          const r = await processEvent(ev);
          processed += 1;
          if (r.duplicate) {
            results.push({ type: ev.type, status: "duplicate" });
          } else {
            if (r.sessionUpdated) sessionUpdates += 1;
            results.push({ type: ev.type, status: "applied" });
          }
        } catch (e) {
          results.push({
            type: ev.type,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return { processed, errors, sessionUpdates, results };
    },

    getProfile,

    getKnowledgeItems(userId) {
      const now = storage.lastEventTs(userId) ?? new Date().toISOString();
      return storage.listKnowledgeItems(userId).map((it) => ({
        ...it,
        effective_state: effectiveState(it, now),
      }));
    },

    getTargetSpec(userId) {
      const now = storage.lastEventTs(userId) ?? new Date().toISOString();
      return buildTargetSpec(storage, userId, now);
    },

    generateMaterial(userId, opts = {}) {
      return runGenerateMaterial({ storage, llm, userId }, opts);
    },

    async replay(userId) {
      const events = storage.listEvents(userId);
      const fresh = createStorage(":memory:");
      // Mock LLM 是确定性的，replay 可复现；真实 LLM 下 replay 结果可能漂移（这正是 replay 要暴露的）
      const replayEngine = createEngine({ storage: fresh, llm, tuning });
      for (const ev of events) await replayEngine.processEvent(ev);
      const replayed = replayEngine.getProfile(userId);
      const current = getProfile(userId);
      const diff: string[] = [];
      const a = replayed.reading_state;
      const b = current.reading_state;
      for (const k of Object.keys(a) as (keyof typeof a)[]) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
          diff.push(`reading_state.${k}: replayed=${JSON.stringify(a[k])} current=${JSON.stringify(b[k])}`);
        }
      }
      if (replayed.version !== current.version) {
        diff.push(`version: replayed=${replayed.version} current=${current.version}`);
      }
      return { replayed, current, diff };
    },
  };
}
