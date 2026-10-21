// 四层指标（第 1 层正确性在 vitest；这里是 2/3/4 层仿真指标）
import type { UserProfile } from "../contracts/profile";
import type { ReadingEvent } from "../contracts/events";
import { rankOf } from "./lexicon";
import type { Persona } from "./personas";

export interface PersonaMetrics {
  personaId: string;
  trueVocab: number;
  finalVocabEstimate: number;
  vocabConvergenceError: number; // |estimate - truth| / truth
  finalBand: string;
  bandChanges: number; // band 变动次数（震荡的直接度量）
  snapshots: number;
  lookupDensities: number[]; // 每个 session 的查词密度
  meanLookupDensity: number;
  knowledgeCounts: Record<string, number>;
  completionRate: number;
}

export function bandChangeCount(snapshots: UserProfile[]): number {
  let changes = 0;
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i].reading_state.band !== snapshots[i - 1].reading_state.band) changes++;
  }
  return changes;
}

export function sessionLookupDensities(events: ReadingEvent[]): number[] {
  const bySession = new Map<string, ReadingEvent[]>();
  for (const e of events) {
    bySession.set(e.session_id, [...(bySession.get(e.session_id) ?? []), e]);
  }
  const densities: number[] = [];
  for (const [, evs] of [...bySession.entries()].sort()) {
    const lookups = evs.filter((e) => e.type === "word_lookup").length;
    const outcome = evs.find((e) => e.type === "material_completed" || e.type === "material_abandoned");
    const wordsRead =
      outcome && (outcome.type === "material_completed" || outcome.type === "material_abandoned")
        ? outcome.words_read
        : 0;
    densities.push(wordsRead > 0 ? (lookups / wordsRead) * 100 : 0);
  }
  return densities;
}

export function computePersonaMetrics(
  persona: Persona,
  profile: UserProfile,
  snapshots: UserProfile[],
  events: ReadingEvent[],
  knowledgeCounts: Record<string, number>,
): PersonaMetrics {
  const densities = sessionLookupDensities(events);
  const completed = events.filter((e) => e.type === "material_completed").length;
  const abandoned = events.filter((e) => e.type === "material_abandoned").length;
  return {
    personaId: persona.id,
    trueVocab: persona.trueVocab,
    finalVocabEstimate: profile.reading_state.vocab_estimate,
    vocabConvergenceError:
      Math.abs(profile.reading_state.vocab_estimate - persona.trueVocab) / persona.trueVocab,
    finalBand: profile.reading_state.band,
    bandChanges: bandChangeCount(snapshots),
    snapshots: snapshots.length,
    lookupDensities: densities.map((d) => Math.round(d * 100) / 100),
    meanLookupDensity:
      Math.round((densities.reduce((a, b) => a + b, 0) / Math.max(1, densities.length)) * 100) / 100,
    knowledgeCounts,
    completionRate: Math.round((completed / Math.max(1, completed + abandoned)) * 100) / 100,
  };
}

export function formatMetrics(m: PersonaMetrics): string {
  return [
    `[${m.personaId}] trueVocab=${m.trueVocab} est=${m.finalVocabEstimate} (err=${(m.vocabConvergenceError * 100).toFixed(1)}%)`,
    `  band=${m.finalBand} bandChanges=${m.bandChanges} snapshots=${m.snapshots} completion=${(m.completionRate * 100).toFixed(0)}%`,
    `  lookupDensity mean=${m.meanLookupDensity}% seq=[${m.lookupDensities.join(", ")}]`,
    `  knowledge: ${Object.entries(m.knowledgeCounts).map(([k, v]) => `${k}=${v}`).join(" ")}`,
  ].join("\n");
}

/** 第 3 层：预测 vs 实际查词 */
export function prf1(predicted: Set<string>, actual: Set<string>) {
  const tp = [...predicted].filter((w) => actual.has(w)).length;
  const precision = predicted.size > 0 ? tp / predicted.size : 0;
  const recall = actual.size > 0 ? tp / actual.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp };
}

/** 预测分数（log-loss 用）：rank 越超 vocab_estimate 越可能查；fading/supported 加权 */
export function lookupScore(
  word: string,
  vocabEstimate: number,
  ledgerState: string | null,
): number {
  const rank = rankOf(word);
  let p = 0.05;
  if (rank !== null) {
    const over = rank - vocabEstimate;
    p = over <= 0 ? 0.02 : Math.min(0.95, 0.3 + over / 2000);
  }
  if (ledgerState === "fading") p = Math.max(p, 0.6);
  if (ledgerState === "supported") p = Math.max(p, 0.7);
  return p;
}

export function logLoss(
  words: string[],
  actual: Set<string>,
  score: (w: string) => number,
): number {
  let sum = 0;
  for (const w of words) {
    const p = Math.min(0.999, Math.max(0.001, score(w)));
    sum += actual.has(w) ? -Math.log(p) : -Math.log(1 - p);
  }
  return sum / Math.max(1, words.length);
}
