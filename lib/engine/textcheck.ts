// 生成材料的确定性体检：tokenize → 逐词分类 → 覆盖率/预算/旧词/avoid 校验。
// 纯函数，不依赖存储与 LLM；rankOf 可注入（默认用 sim 合成词表）。
//
// 计数口径：review 词（账本 supported/fading）是刻意重现，不计入 predicted_lookup_rate，
// 否则旧词清单一长验收闸门就无法收敛；只有硬生词（stretch / untracked / 账本 new）计入。
import type { KnowledgeState } from "../../contracts/knowledge";
import type { TargetSpec } from "../../contracts/target-spec";
import type { DraftReport } from "../../contracts/generator";
import { defaultRankOf } from "./lexicon";

export type RankOf = (word: string) => number | null;

export const KNOWN_RANK_RATIO = 0.98; // rank < vocab×0.98 视为已知区（对齐 98% 覆盖上界）
export const REVIEW_MIN_RATIO = 0.8; // review_items 至少 80% 在文中出现

export interface CheckContext {
  spec: TargetSpec;
  targetLookupRate: [number, number];
  ledger: Map<string, KnowledgeState>;
  vocabEstimate: number;
  rankOf?: RankOf;
}

export type WordClass =
  | "known_ledger" // 账本 familiar/mastered
  | "review_ledger" // 账本 supported/fading：刻意重现，不计入硬生词率
  | "new_ledger" // 账本 new：计入硬生词率
  | "known_rank" // 未跟踪，rank < vocab×0.98
  | "stretch" // 未跟踪，rank ≥ vocab×0.98：N+1 拉伸区
  | "untracked"; // 账本与词表都无法判定，保守按 stretch 计

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
}

export function classifyWord(
  word: string,
  ledger: Map<string, KnowledgeState>,
  vocabEstimate: number,
  rankOf: RankOf = defaultRankOf,
): WordClass {
  const state = ledger.get(word);
  if (state === "familiar" || state === "mastered") return "known_ledger";
  if (state === "supported" || state === "fading") return "review_ledger";
  if (state === "new") return "new_ledger";
  const rank = rankOf(word);
  if (rank === null) return "untracked";
  return rank < vocabEstimate * KNOWN_RANK_RATIO ? "known_rank" : "stretch";
}

const HARD_CLASSES: ReadonlySet<WordClass> = new Set(["new_ledger", "stretch", "untracked"]);

export function checkDraft(text: string, ctx: CheckContext): DraftReport {
  const { spec } = ctx;
  const rankOf = ctx.rankOf ?? defaultRankOf;
  const tokens = tokenize(text);
  const length = tokens.length;
  const tokenSet = new Set(tokens);

  let hardTokens = 0;
  let reviewOccurrences = 0;
  const newItems = new Set<string>();
  const untrackedItems = new Set<string>();
  for (const tok of tokens) {
    const cls = classifyWord(tok, ctx.ledger, ctx.vocabEstimate, rankOf);
    if (cls === "review_ledger") reviewOccurrences += 1;
    if (HARD_CLASSES.has(cls)) {
      hardTokens += 1;
      if (cls === "stretch") newItems.add(tok);
      if (cls === "untracked") {
        newItems.add(tok);
        untrackedItems.add(tok);
      }
    }
  }

  const predictedLookupRate = length > 0 ? hardTokens / length : 1;
  const lengthOk = length >= spec.length_words[0] && length <= spec.length_words[1];
  const coverageOk = predictedLookupRate <= ctx.targetLookupRate[1];
  const budget = spec.new_item_budget;
  const budgetOk = newItems.size <= budget;
  const avoidViolations = spec.avoid_items.filter((w) => tokenSet.has(w.toLowerCase()));
  const reviewCoverage = spec.review_items.map((ri) => ({
    item: ri.item,
    present: tokenSet.has(ri.item.toLowerCase()),
  }));
  const reviewPresent = reviewCoverage.filter((r) => r.present).length;
  const reviewOk = reviewPresent >= Math.ceil(REVIEW_MIN_RATIO * reviewCoverage.length);

  const failures: string[] = [];
  if (!lengthOk) failures.push(`length ${length} outside range [${spec.length_words[0]},${spec.length_words[1]}]`);
  if (!coverageOk)
    failures.push(
      `predicted_lookup_rate ${(predictedLookupRate * 100).toFixed(1)}% above target hi ${(ctx.targetLookupRate[1] * 100).toFixed(1)}%`,
    );
  if (!budgetOk) failures.push(`new_items ${newItems.size} over budget ${budget}`);
  if (avoidViolations.length > 0) failures.push(`avoid_items present: ${avoidViolations.join(",")}`);
  if (!reviewOk) {
    const missing = reviewCoverage.filter((r) => !r.present).map((r) => r.item);
    failures.push(`review_items missing: ${missing.join(",")}`);
  }

  return {
    length_words: length,
    length_ok: lengthOk,
    predicted_lookup_rate: Math.round(predictedLookupRate * 10000) / 10000,
    coverage_ok: coverageOk,
    new_items: [...newItems].sort(),
    new_items_used: newItems.size,
    new_item_budget: budget,
    budget_ok: budgetOk,
    review_coverage: reviewCoverage,
    review_occurrences: reviewOccurrences,
    review_ok: reviewOk,
    avoid_violations: avoidViolations,
    untracked_items: [...untrackedItems].sort(),
    pass: failures.length === 0,
    failures,
  };
}
