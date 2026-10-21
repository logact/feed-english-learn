// 知识点状态机：确定性纯函数，不依赖存储与 LLM。
//
// 状态：new → supported → familiar → mastered，外加 fading（惰性检测）。
//   new:       首次查词
//   supported: 短期内再次查询（仍需辅助）
//   familiar:  后续 session 中出现且未查
//   mastered:  累计 MASTER_EXPOSURES 次无查询曝光，或被主动标记认识
//   fading:    familiar/mastered 但超过 T 天未在任何材料中出现（T 随状态加深变长）。
//              fading 不落库，查询时用 effectiveState() 惰性计算。
//
// 所有迁移都以「有效状态」（含惰性 fading）为基准。

import type { KnowledgeItem, KnowledgeState } from "../../contracts/knowledge";

export const MASTER_EXPOSURES = 3; // familiar 状态下累计无查询曝光次数 → mastered
export const FADING_DAYS: Partial<Record<KnowledgeState, number>> = {
  familiar: 14,
  mastered: 30,
};
export const MAX_SAMPLE_CONTEXTS = 2;

export type KnowledgeEvent =
  | { kind: "lookup"; sessionId: string; ts: string; sentence?: string }
  | { kind: "exposure"; sessionId: string; ts: string; count?: number; sentence?: string }
  | { kind: "known"; sessionId: string; ts: string };

export interface TransitionResult {
  item: KnowledgeItem;
  /** from 为有效状态（含惰性 fading）；无迁移时为 null */
  changed: { from: KnowledgeState | null; to: KnowledgeState } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

/** 惰性 fading：familiar/mastered 超过 T 天未出现 → 有效状态为 fading */
export function effectiveState(item: KnowledgeItem, now: string): KnowledgeState {
  const threshold = FADING_DAYS[item.state];
  if (threshold !== undefined && daysBetween(item.last_seen, now) > threshold) {
    return "fading";
  }
  return item.state;
}

function baseItem(lemma: string, itemType: "word" | "phrase", ts: string): KnowledgeItem {
  return {
    item: lemma,
    item_type: itemType,
    state: "new",
    lookup_count: 0,
    exposure_count: 0,
    first_seen: ts,
    last_seen: ts,
    last_lookup_ts: null,
    last_lookup_session: null,
    next_review: null,
    note: null,
    sample_contexts: [],
  };
}

function pushContext(item: KnowledgeItem, sentence?: string): void {
  if (!sentence) return;
  item.sample_contexts = [sentence, ...item.sample_contexts.filter((s) => s !== sentence)].slice(
    0,
    MAX_SAMPLE_CONTEXTS,
  );
}

/** 首次查词建条目（state = new） */
export function createFromLookup(
  lemma: string,
  itemType: "word" | "phrase",
  ev: Extract<KnowledgeEvent, { kind: "lookup" }>,
): TransitionResult {
  const item = baseItem(lemma, itemType, ev.ts);
  item.lookup_count = 1;
  item.last_lookup_ts = ev.ts;
  item.last_lookup_session = ev.sessionId;
  pushContext(item, ev.sentence);
  return { item, changed: { from: null, to: "new" } };
}

/** 首次主动标记认识建条目（state = mastered） */
export function createFromKnown(
  lemma: string,
  itemType: "word" | "phrase",
  ev: Extract<KnowledgeEvent, { kind: "known" }>,
): TransitionResult {
  const item = baseItem(lemma, itemType, ev.ts);
  item.state = "mastered";
  item.exposure_count = MASTER_EXPOSURES;
  return { item, changed: { from: null, to: "mastered" } };
}

/**
 * 对已存在的条目应用一次知识点事件。
 * fading 只作为输入侧的有效状态出现，不会作为输出落库。
 */
export function transition(current: KnowledgeItem, ev: KnowledgeEvent, now: string): TransitionResult {
  const item: KnowledgeItem = { ...current, sample_contexts: [...current.sample_contexts] };
  const from = effectiveState(item, now);
  let to: KnowledgeState = from;

  switch (ev.kind) {
    case "lookup": {
      item.lookup_count += 1;
      item.last_lookup_ts = ev.ts;
      item.last_lookup_session = ev.sessionId;
      item.last_seen = ev.ts;
      pushContext(item, ev.sentence);
      if (from === "new") {
        to = "supported";
      } else if (from === "familiar" || from === "mastered" || from === "fading") {
        // 回退：查了就是还需要辅助
        to = "supported";
      }
      break;
    }
    case "exposure": {
      if (ev.sessionId === item.last_lookup_session) {
        // 同 session 内查过：不算无查询曝光，但更新 last_seen
        item.last_seen = ev.ts;
        break;
      }
      item.exposure_count += ev.count ?? 1;
      item.last_seen = ev.ts;
      pushContext(item, ev.sentence);
      if (from === "new" || from === "supported") {
        // 后续 session 出现且未查 → 熟悉中
        to = "familiar";
      } else if (from === "familiar") {
        if (item.exposure_count >= MASTER_EXPOSURES) to = "mastered";
      } else if (from === "fading") {
        // 遗忘后重现且未查 → 复活为 familiar
        to = "familiar";
        item.next_review = null;
      }
      break;
    }
    case "known": {
      item.last_seen = ev.ts;
      to = "mastered";
      break;
    }
  }

  item.state = to;
  return { item, changed: from !== to ? { from, to } : null };
}

/**
 * LLM 回流（审核员通道）的合法迁移白名单。
 * 不允许直接跃迁：如 new→mastered、familiar→mastered 需走曝光计数或显式 word_known。
 */
export const LEGAL_TRANSITIONS: Record<KnowledgeState, KnowledgeState[]> = {
  new: ["supported", "familiar"],
  supported: ["new", "familiar"],
  familiar: ["supported", "fading"],
  mastered: ["supported", "fading"],
  fading: ["supported", "familiar"],
};

export function isLegalTransition(from: KnowledgeState, to: KnowledgeState): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}
