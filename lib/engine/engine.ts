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
import { runSessionUpdate, type Tuning } from "./profiler";
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

export interface ProcessResult {
  processed: number;
  errors: { index: number; error: string }[];
  /** 触发了尺度 2 更新的 session 数 */
  sessionUpdates: number;
}

export interface Engine {
  storage: Storage;
  llm: LLMClient;
  processEvent(ev: ReadingEvent): Promise<void>;
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

  function applyKnowledgeEvent(
    userId: string,
    lemmaRaw: string,
    itemType: "word" | "phrase",
    ev: Parameters<typeof transition>[1],
    sessionId: string,
    ts: string,
  ): void {
    const lemma = lemmaRaw.toLowerCase();
    const existing = storage.getKnowledgeItem(userId, lemma);
    let result;
    if (!existing) {
      if (ev.kind === "lookup") result = createFromLookup(lemma, itemType, ev);
      else if (ev.kind === "known") result = createFromKnown(lemma, itemType, ev);
      else return; // 未跟踪词的纯曝光不建条目
    } else {
      result = transition(existing, ev, ts);
    }
    storage.upsertKnowledgeItem(userId, result.item, ts);
    if (result.changed) {
      storage.insertKnowledgeChange({
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
  }

  /** session 结束时的曝光记账：材料文本中出现且本 session 未查的词 */
  function accountExposures(userId: string, sessionId: string, ts: string): void {
    const sessionEvents = storage.listSessionEvents(userId, sessionId);
    const startEv = sessionEvents.find((e) => e.type === "session_start");
    const materialId =
      sessionEvents.find((e) => e.type === "material_completed" || e.type === "material_abandoned")
        ?.material_id ?? (startEv?.type === "session_start" ? startEv.material.material_id : null);
    if (!materialId) return;
    const material = storage.getMaterial(userId, materialId);
    if (!material?.text) return;

    const lookedUp = new Set(
      sessionEvents.filter((e) => e.type === "word_lookup").map((e) => e.lemma.toLowerCase()),
    );
    const tokens = new Set(material.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []);
    for (const item of storage.listKnowledgeItems(userId)) {
      if (!tokens.has(item.item)) continue;
      if (lookedUp.has(item.item)) continue; // 查过：lookup 已记账
      applyKnowledgeEvent(
        userId,
        item.item,
        item.item_type,
        { kind: "exposure", sessionId, ts, sentence: firstSentenceWith(material.text, item.item) },
        sessionId,
        ts,
      );
    }
  }

  async function processEvent(ev: ReadingEvent): Promise<void> {
    storage.insertEvent(ev);
    switch (ev.type) {
      case "session_start":
        storage.saveMaterial(ev.user_id, ev.material);
        break;
      case "word_lookup":
        applyKnowledgeEvent(
          ev.user_id,
          ev.lemma,
          ev.item_type,
          { kind: "lookup", sessionId: ev.session_id, ts: ev.ts, sentence: ev.sentence },
          ev.session_id,
          ev.ts,
        );
        break;
      case "word_known":
        applyKnowledgeEvent(
          ev.user_id,
          ev.lemma,
          "word",
          { kind: "known", sessionId: ev.session_id, ts: ev.ts },
          ev.session_id,
          ev.ts,
        );
        break;
      case "material_completed":
      case "material_abandoned":
      case "feedback":
        break; // 计入事件流，由 digest 消费
      case "session_end":
        accountExposures(ev.user_id, ev.session_id, ev.ts);
        await runSessionUpdate(storage, llm, ev.user_id, ev.session_id, tuning);
        break;
    }
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
      let sessionUpdates = 0;
      for (const ev of events) {
        const before = ev.type === "session_end" ? storage.listJournal(ev.user_id).length : -1;
        await processEvent(ev);
        if (ev.type === "session_end" && storage.listJournal(ev.user_id).length > before) {
          sessionUpdates += 1;
        }
      }
      return { processed: events.length, errors, sessionUpdates };
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
