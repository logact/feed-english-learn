// 尺度 2 / 尺度 3 编排：digest → prompt → LLM → Zod 校验 → clamp → 落库 → journal。
// clamp 与滞回 gate 全部在代码中强制，不依赖 prompt 自觉。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProfileSessionUpdateSchema,
  StageReviewOutputSchema,
  BANDS,
  defaultProfile,
  type Band,
  type ProfileSessionUpdate,
  type StageReviewOutput,
  type UserProfile,
} from "../../contracts/profile";
import type { KnowledgeItem } from "../../contracts/knowledge";
import type { MaterialMeta, ReadingEvent } from "../../contracts/events";
import type { LLMClient, LLMMessage } from "./llm";
import type { Storage } from "./storage";
import { buildSessionDigest, buildStageDigest, parseLookupDensity, summarizeKnowledge } from "./digest";
import { effectiveState, isLegalTransition } from "./knowledge";

// ---- 代码常量（调优旋钮，见 PRD 调优工作流） ----
export const STAGE_REVIEW_INTERVAL = 5; // K：每 K 个 session 触发阶段检查
export const HYSTERESIS_SESSIONS = 3; // 滞回窗口
export const HYSTERESIS_UP_DENSITY = 1; // 最近 3 session 查词密度均 <1% 才允许升级
export const HYSTERESIS_DOWN_DENSITY = 5; // 均 >5% 才允许降级
export const CLAMP_LENGTH_PCT = 0.2; // 尺度 2 篇幅单次 ±20%
export const CLAMP_WPM_PCT = 0.1; // 尺度 2 速度单次 ±10%
export const STAGE_VOCAB_CLAMP_PCT = 0.2; // 尺度 3 词汇量单次 ±20%

export const PROMPT_VERSIONS = {
  session: "update_profile@v1",
  stage: "stage_review@v1",
  predict: "predict_lookups@v1",
  judge: "judge@v1",
  generate: "generate_material@v1",
} as const;

/** 调优旋钮（sim/tune.ts 网格对比用）；缺省回落到代码常量 */
export interface Tuning {
  clampLengthPct?: number;
  clampWpmPct?: number;
  stageReviewInterval?: number;
}

const promptCache = new Map<string, string>();

export function loadPrompt(name: keyof typeof PROMPT_VERSIONS | string): string {
  const file = name.replace(/@.*$/, "") + ".md";
  if (!promptCache.has(file)) {
    promptCache.set(file, readFileSync(join(process.cwd(), "lib/engine/prompts", file), "utf8"));
  }
  return promptCache.get(file)!;
}

// ---- 纯函数：clamp 与应用更新（单测直接覆盖） ----

export function clampInt(proposed: number, current: number, pct: number): number {
  const lo = Math.floor(current * (1 - pct));
  const hi = Math.ceil(current * (1 + pct));
  return Math.min(hi, Math.max(lo, Math.round(proposed)));
}

export interface AppliedUpdate {
  profile: UserProfile;
  delta: Record<string, { from: unknown; to: unknown }>;
}

/** 尺度 2：应用 session 更新。band/vocab_estimate 结构性不存在于输入 schema，此处也不可能被改。 */
export function applySessionUpdate(
  profile: UserProfile,
  update: ProfileSessionUpdate,
  now: string,
  tuning: Tuning = {},
): AppliedUpdate {
  const clampLength = tuning.clampLengthPct ?? CLAMP_LENGTH_PCT;
  const clampWpm = tuning.clampWpmPct ?? CLAMP_WPM_PCT;
  const next: UserProfile = JSON.parse(JSON.stringify(profile)) as UserProfile;
  const delta: AppliedUpdate["delta"] = {};
  const rs = next.reading_state;
  const u = update.reading_state;

  if (u.comfortable_length_words !== undefined) {
    const v = clampInt(u.comfortable_length_words, rs.comfortable_length_words, clampLength);
    if (v !== rs.comfortable_length_words) {
      delta["reading_state.comfortable_length_words"] = { from: rs.comfortable_length_words, to: v };
      rs.comfortable_length_words = v;
    }
  }
  if (u.max_length_words !== undefined) {
    let v = clampInt(u.max_length_words, rs.max_length_words, clampLength);
    v = Math.max(v, rs.comfortable_length_words);
    if (v !== rs.max_length_words) {
      delta["reading_state.max_length_words"] = { from: rs.max_length_words, to: v };
      rs.max_length_words = v;
    }
  }
  if (u.reading_speed_wpm !== undefined) {
    const v = clampInt(u.reading_speed_wpm, rs.reading_speed_wpm, clampWpm);
    if (v !== rs.reading_speed_wpm) {
      delta["reading_state.reading_speed_wpm"] = { from: rs.reading_speed_wpm, to: v };
      rs.reading_speed_wpm = v;
    }
  }
  if (u.confidence !== undefined && u.confidence !== rs.confidence) {
    delta["reading_state.confidence"] = { from: rs.confidence, to: u.confidence };
    rs.confidence = u.confidence;
  }
  if (u.target_lookup_rate !== undefined) {
    const lo = Math.min(0.15, Math.max(0.005, u.target_lookup_rate[0]));
    const hi = Math.min(0.15, Math.max(lo, u.target_lookup_rate[1]));
    const v: [number, number] = [lo, hi];
    if (v[0] !== rs.target_lookup_rate[0] || v[1] !== rs.target_lookup_rate[1]) {
      delta["reading_state.target_lookup_rate"] = { from: rs.target_lookup_rate, to: v };
      rs.target_lookup_rate = v;
    }
  }
  rs.evidence = u.evidence;
  rs.sessions_since_review = rs.sessions_since_review + 1;

  delta["interests"] = { from: profile.interests, to: update.interests };
  delta["notes"] = { from: profile.notes, to: update.notes };
  next.interests = update.interests;
  next.notes = update.notes;
  next.version = profile.version + 1;
  next.updated_at = now;
  return { profile: next, delta };
}

export type StageGate = "up" | "down" | "hold";

/** 滞回 gate：最近 3 个 session 查词密度同向才放行对应方向 */
export function stageGate(recentSessionDigests: string[]): StageGate {
  const densities = recentSessionDigests
    .slice(-HYSTERESIS_SESSIONS)
    .map(parseLookupDensity)
    .filter((d): d is number => d !== null);
  if (densities.length < HYSTERESIS_SESSIONS) return "hold";
  if (densities.every((d) => d < HYSTERESIS_UP_DENSITY)) return "up";
  if (densities.every((d) => d > HYSTERESIS_DOWN_DENSITY)) return "down";
  return "hold";
}

/** 尺度 3：应用阶段检查结果。band 最多一级且方向受 gate 约束；vocab ±20% 且方向受 gate 约束。 */
export function applyStageReview(
  profile: UserProfile,
  output: StageReviewOutput,
  gate: StageGate,
  now: string,
): AppliedUpdate {
  const next: UserProfile = JSON.parse(JSON.stringify(profile)) as UserProfile;
  const delta: AppliedUpdate["delta"] = { gate: { from: null, to: gate } };
  const rs = next.reading_state;

  if (output.adjust && gate !== "hold") {
    if (output.band !== undefined) {
      const cur = BANDS.indexOf(rs.band);
      const proposed = BANDS.indexOf(output.band);
      let step = proposed - cur;
      // 方向必须同 gate 一致，且最多一级
      if (gate === "up") step = Math.min(Math.max(step, 0), 1);
      else step = Math.max(Math.min(step, 0), -1);
      if (step !== 0) {
        const newBand: Band = BANDS[cur + step];
        delta["reading_state.band"] = { from: rs.band, to: newBand };
        rs.band = newBand;
      }
    }
    if (output.vocab_estimate !== undefined) {
      const maxDelta = Math.round(rs.vocab_estimate * STAGE_VOCAB_CLAMP_PCT);
      let v = clampInt(output.vocab_estimate, rs.vocab_estimate, STAGE_VOCAB_CLAMP_PCT);
      if (gate === "up") v = Math.min(rs.vocab_estimate + maxDelta, Math.max(rs.vocab_estimate, v));
      else v = Math.max(rs.vocab_estimate - maxDelta, Math.min(rs.vocab_estimate, v));
      if (v !== rs.vocab_estimate) {
        delta["reading_state.vocab_estimate"] = { from: rs.vocab_estimate, to: v };
        rs.vocab_estimate = v;
      }
    }
  }
  if (output.confidence !== undefined && output.confidence !== rs.confidence) {
    delta["reading_state.confidence"] = { from: rs.confidence, to: output.confidence };
    rs.confidence = output.confidence;
  }
  rs.evidence = output.evidence;
  rs.sessions_since_review = 0;
  next.version = profile.version + 1;
  next.updated_at = now;
  return { profile: next, delta };
}

// ---- 编排 ----

function sessionItemUniverse(events: ReadingEvent[], material: MaterialMeta | null): Set<string> {
  const items = new Set<string>();
  for (const e of events) {
    if (e.type === "word_lookup") items.add(e.lemma);
    if (e.type === "word_known") items.add(e.lemma);
  }
  if (material?.text) {
    for (const tok of material.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
      items.add(tok);
    }
  }
  return items;
}

export interface SessionUpdateResult {
  digest: string;
  applied: AppliedUpdate;
  annotationsApplied: number;
  annotationsRejected: { item: string; reason: string }[];
  stageReview: { ran: boolean; gate?: StageGate; delta?: Record<string, unknown> } | null;
}

export async function runSessionUpdate(
  storage: Storage,
  llm: LLMClient,
  userId: string,
  sessionId: string,
  tuning: Tuning = {},
): Promise<SessionUpdateResult> {
  const now = storage.lastEventTs(userId) ?? new Date().toISOString();
  const profile = storage.getProfile(userId) ?? defaultProfile(userId, now);
  const events = storage.listSessionEvents(userId, sessionId);

  const startEv = events.find((e) => e.type === "session_start");
  const material = startEv?.type === "session_start" ? startEv.material : null;
  const changes = storage
    .listKnowledgeChanges(userId)
    .filter((c) => c.session_id === sessionId);

  const digest = buildSessionDigest({ events, material, knowledgeChanges: changes });

  const messages: LLMMessage[] = [
    { role: "system", content: loadPrompt("update_profile") },
    {
      role: "user",
      content:
        `SESSION_DIGEST:\n${digest}\n\n` +
        `CURRENT_PROFILE_JSON:\n${JSON.stringify(profile, null, 2)}`,
    },
  ];

  const result = await llm.complete({
    schemaName: "ProfileSessionUpdate",
    schema: ProfileSessionUpdateSchema,
    messages,
  });

  const { profile: updated, delta } = applySessionUpdate(profile, result.data, now, tuning);

  // ---- knowledge_annotations 回流：校验后应用，全部记 knowledge_changes ----
  const universe = sessionItemUniverse(events, material);
  const annotationsRejected: { item: string; reason: string }[] = [];
  let annotationsApplied = 0;
  for (const ann of result.data.knowledge_annotations) {
    const lemma = ann.item.toLowerCase();
    if (!universe.has(lemma)) {
      annotationsRejected.push({ item: ann.item, reason: "item not present in this session" });
      continue;
    }
    const existing = storage.getKnowledgeItem(userId, lemma);
    if (!existing) {
      annotationsRejected.push({ item: ann.item, reason: "item not in knowledge ledger" });
      continue;
    }
    const from = effectiveState(existing, now);
    if (from === ann.suggest_state) continue; // 无变化
    if (!isLegalTransition(from, ann.suggest_state)) {
      annotationsRejected.push({ item: ann.item, reason: `illegal transition ${from}→${ann.suggest_state}` });
      continue;
    }
    const nextItem: KnowledgeItem = {
      ...existing,
      state: ann.suggest_state,
      note: ann.note,
      next_review: ann.suggest_state === "fading" ? now : existing.next_review,
    };
    storage.upsertKnowledgeItem(userId, nextItem, now);
    storage.insertKnowledgeChange({
      user_id: userId,
      session_id: sessionId,
      item: lemma,
      from_state: from,
      to_state: ann.suggest_state,
      trigger: "llm_annotation",
      note: ann.note,
      ts: now,
    });
    annotationsApplied += 1;
  }
  delta["knowledge_annotations"] = {
    from: null,
    to: { applied: annotationsApplied, rejected: annotationsRejected },
  };

  storage.saveProfile(updated);
  storage.insertJournal({
    userId,
    scale: "session",
    promptVersion: PROMPT_VERSIONS.session,
    model: result.model,
    inputSummary: digest,
    rawResponse: result.raw,
    delta: { ...delta, attempts: { from: null, to: result.attempts } },
    usage: result.usage,
    createdAt: new Date().toISOString(),
  });

  // ---- 尺度 3 触发 ----
  let stageReview: SessionUpdateResult["stageReview"] = null;
  const k = tuning.stageReviewInterval ?? STAGE_REVIEW_INTERVAL;
  if (updated.reading_state.sessions_since_review >= k) {
    stageReview = await runStageReview(storage, llm, userId);
  }

  return { digest, applied: { profile: updated, delta }, annotationsApplied, annotationsRejected, stageReview };
}

export async function runStageReview(
  storage: Storage,
  llm: LLMClient,
  userId: string,
): Promise<{ ran: boolean; gate: StageGate; delta: Record<string, unknown> }> {
  const now = storage.lastEventTs(userId) ?? new Date().toISOString();
  const profile = storage.getProfile(userId) ?? defaultProfile(userId, now);

  const journal = storage.listJournal(userId).filter((j) => j.scale === "session");
  const recentDigests = journal.slice(-STAGE_REVIEW_INTERVAL).map((j) => j.inputSummary);
  const gate = stageGate(recentDigests);

  if (gate === "hold") {
    // 滞回未放行：不调 LLM，归零计数并记 journal
    const next: UserProfile = JSON.parse(JSON.stringify(profile)) as UserProfile;
    next.reading_state.sessions_since_review = 0;
    next.version = profile.version + 1;
    next.updated_at = now;
    storage.saveProfile(next);
    storage.insertJournal({
      userId,
      scale: "stage_review",
      promptVersion: PROMPT_VERSIONS.stage,
      model: "none",
      inputSummary: `gate=hold (recent densities not consistently <${HYSTERESIS_UP_DENSITY}% or >${HYSTERESIS_DOWN_DENSITY}%)`,
      rawResponse: "",
      delta: { gate: { from: null, to: "hold" }, skipped_llm: { from: null, to: true } },
      usage: null,
      createdAt: new Date().toISOString(),
    });
    return { ran: true, gate, delta: { skipped_llm: true } };
  }

  const items = storage.listKnowledgeItems(userId);
  const changes = storage.listKnowledgeChanges(userId);
  const recentSessionIds = new Set(
    journal.slice(-STAGE_REVIEW_INTERVAL).map((j) => j.inputSummary.match(/session_id=(\S+)/)?.[1] ?? ""),
  );
  const summary = summarizeKnowledge(items, changes, recentSessionIds, now, effectiveState);
  const stageDigest = buildStageDigest(recentDigests, summary, STAGE_REVIEW_INTERVAL);

  const messages: LLMMessage[] = [
    { role: "system", content: loadPrompt("stage_review") },
    {
      role: "user",
      content:
        `GATE=${gate}\n\nSTAGE_DIGEST:\n${stageDigest}\n\n` +
        `CURRENT_PROFILE_JSON:\n${JSON.stringify(profile, null, 2)}`,
    },
  ];

  const result = await llm.complete({
    schemaName: "StageReviewOutput",
    schema: StageReviewOutputSchema,
    messages,
  });

  const { profile: updated, delta } = applyStageReview(profile, result.data, gate, now);
  storage.saveProfile(updated);
  storage.insertJournal({
    userId,
    scale: "stage_review",
    promptVersion: PROMPT_VERSIONS.stage,
    model: result.model,
    inputSummary: stageDigest,
    rawResponse: result.raw,
    delta: { ...delta, attempts: { from: null, to: result.attempts } },
    usage: result.usage,
    createdAt: new Date().toISOString(),
  });
  return { ran: true, gate, delta: delta as Record<string, unknown> };
}
