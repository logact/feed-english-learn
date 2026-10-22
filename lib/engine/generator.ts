// 组件 2 生成 loop 驱动：TargetSpec → 结构化回合（LLM 提议）→ 确定性体检（代码裁决）→ 落库。
// 不依赖 Next.js，可在 tsx 脚本 / vitest 中独立使用。
import { z } from "zod";
import { defaultProfile } from "../../contracts/profile";
import type { MaterialMeta } from "../../contracts/events";
import type { ReviewItem, TargetSpec } from "../../contracts/target-spec";
import {
  CHECK_WORDS_LIMIT,
  GeneratorTurnSchema,
  type DraftReport,
  type GeneratedMaterial,
  type SubmitTurn,
} from "../../contracts/generator";
import { effectiveState } from "./knowledge";
import { checkDraft, classifyWord, type CheckContext, type RankOf } from "./textcheck";
import { loadPrompt, PROMPT_VERSIONS } from "./profiler";
import type { LLMClient, LLMMessage, TokenUsage } from "./llm";
import type { Storage } from "./storage";

export const GENERATOR_MAX_TURNS = 8;

const GeneratorTurnResponseSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null) return value;
  const turn = value as Record<string, unknown>;
  if (
    turn.action !== "check_words" ||
    !Array.isArray(turn.words) ||
    turn.words.length <= CHECK_WORDS_LIMIT
  ) {
    return value;
  }
  return { ...turn, words: turn.words.slice(0, CHECK_WORDS_LIMIT) };
}, GeneratorTurnSchema);

// ---------------------------------------------------------------------------
// TargetSpec 组装（自 engine.ts 迁入的纯函数；engine.getTargetSpec 委托到此）
// ---------------------------------------------------------------------------

const REVIEW_ITEMS_CAP = 20;
const AVOID_ITEMS_CAP = 10;
const AVOID_LOOKUP_THRESHOLD = 3; // new 状态且查了 >=3 次：显挫折，暂缓重现

export function buildTargetSpec(storage: Storage, userId: string, now: string): TargetSpec {
  const profile = storage.getProfile(userId) ?? defaultProfile(userId, now);
  const items = storage.listKnowledgeItems(userId);
  const withEffective = items.map((it) => ({ it, eff: effectiveState(it, now) }));

  const reviewItems: ReviewItem[] = withEffective
    .filter((x) => x.eff === "fading" || x.eff === "supported")
    .sort((a, b) => (a.eff === b.eff ? 0 : a.eff === "fading" ? -1 : 1))
    .slice(0, REVIEW_ITEMS_CAP)
    .map((x) => ({
      item: x.it.item,
      state: x.eff as ReviewItem["state"],
      sample_context: x.it.sample_contexts[0] ?? null,
    }));

  const avoidItems = withEffective
    .filter((x) => x.eff === "new" && x.it.lookup_count >= AVOID_LOOKUP_THRESHOLD)
    .slice(0, AVOID_ITEMS_CAP)
    .map((x) => x.it.item);

  const rs = profile.reading_state;
  return {
    user_id: userId,
    band: rs.band,
    length_words: [rs.comfortable_length_words, rs.max_length_words],
    topics: [...profile.interests].sort((a, b) => b.weight - a.weight).slice(0, 3).map((i) => i.topic),
    review_items: reviewItems,
    new_item_budget: Math.max(1, Math.round(rs.comfortable_length_words * rs.target_lookup_rate[0])),
    avoid_items: avoidItems,
    notes: profile.notes.slice(0, 300),
    generated_at: new Date().toISOString(),
  };
}

/** 最近若干 session 的材料话题（去重），供生成时避免重复 */
export function recentTopics(storage: Storage, userId: string, sessions = 3): string[] {
  const events = storage.listEvents(userId);
  const topics: string[] = [];
  let seen = 0;
  for (let i = events.length - 1; i >= 0 && seen < sessions; i--) {
    const e = events[i];
    if (e.type !== "session_start") continue;
    seen += 1;
    for (const t of e.material.topics) if (!topics.includes(t)) topics.push(t);
  }
  return topics;
}

// ---------------------------------------------------------------------------
// 生成 loop
// ---------------------------------------------------------------------------

export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorError";
  }
}

export interface GenerateOptions {
  rankOf?: RankOf;
  maxTurns?: number;
  /** 可注入 material_id（测试 / sim 可复现） */
  materialId?: string;
  /** 可注入基准时间（测试 / sim 可复现） */
  now?: string;
}

/** 兜底打草稿分：failures 优先，其次覆盖率缺口，越低越好 */
function scoreReport(report: DraftReport, targetHi: number): number {
  return report.failures.length + Math.max(0, report.predicted_lookup_rate - targetHi);
}

export async function generateMaterial(
  deps: { storage: Storage; llm: LLMClient; userId: string },
  opts: GenerateOptions = {},
): Promise<GeneratedMaterial> {
  const { storage, llm, userId } = deps;
  const maxTurns = opts.maxTurns ?? GENERATOR_MAX_TURNS;
  const now = opts.now ?? storage.lastEventTs(userId) ?? new Date().toISOString();
  const profile = storage.getProfile(userId) ?? defaultProfile(userId, now);
  const spec = buildTargetSpec(storage, userId, now);
  const ledger = new Map(
    storage.listKnowledgeItems(userId).map((it) => [it.item, effectiveState(it, now)] as const),
  );
  const targetHi = profile.reading_state.target_lookup_rate[1];
  const ledgerHard = storage
    .listKnowledgeItems(userId)
    .filter((it) => effectiveState(it, now) === "new")
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen)) // 最新受挫的词优先，避免截断漏掉热词
    .slice(0, 50)
    .map((it) => it.item);
  const ctx: CheckContext = {
    spec,
    targetLookupRate: profile.reading_state.target_lookup_rate,
    ledger,
    vocabEstimate: profile.reading_state.vocab_estimate,
    rankOf: opts.rankOf,
  };
  const inputSummary =
    `band=${spec.band} length=[${spec.length_words.join(",")}] budget=${spec.new_item_budget} ` +
    `review=${spec.review_items.length} avoid=${spec.avoid_items.length} topics=[${spec.topics.join(",")}]`;

  const messages: LLMMessage[] = [
    { role: "system", content: loadPrompt("generate_material") },
    {
      role: "user",
      content:
        `TARGET_SPEC_JSON:\n${JSON.stringify(spec, null, 2)}\n\n` +
        `VOCAB_ESTIMATE=${profile.reading_state.vocab_estimate}\n` +
        `TARGET_LOOKUP_RATE=[${profile.reading_state.target_lookup_rate.join(",")}]\n` +
        `LEDGER_HARD=[${ledgerHard.join(",")}]\n` +
        `RECENT_TOPICS=[${recentTopics(storage, userId).join(",")}]\n\n` +
        "Begin. Reply with exactly one GeneratorTurn JSON object per turn.",
    },
  ];

  let chosen: { turn: SubmitTurn; report: DraftReport } | null = null;
  let best: { turn: SubmitTurn; report: DraftReport; score: number } | null = null;
  let turns = 0;
  let toolCalls = 0;
  let lastRaw = "";
  let lastModel = llm.modelName();
  let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  let sawUsage = false;
  const trace: string[] = [];

  /** check_draft 的草稿同样是可验收的候选：补上 submit 元数据后纳入裁决 */
  const synthesizeSubmit = (text: string): SubmitTurn => ({
    action: "submit",
    text,
    summary: text.slice(0, 160),
    topics: spec.topics.slice(0, 2).length > 0 ? spec.topics.slice(0, 2) : ["general"],
    new_items: [],
  });

  const turnBudgetNote = (t: number) =>
    `[turn ${t}/${maxTurns}` +
    (t >= maxTurns - 1 ? " — you MUST submit your best draft next turn]" : "]");

  for (let t = 1; t <= maxTurns; t++) {
    turns = t;
    const result = await llm.complete({
      schemaName: "GeneratorTurn",
      schema: GeneratorTurnResponseSchema,
      messages,
      trace: { userId, scale: "generate", promptVersion: PROMPT_VERSIONS.generate, turn: t },
    });
    lastRaw = result.raw;
    lastModel = result.model;
    if (result.usage) {
      sawUsage = true;
      totalUsage = {
        promptTokens: totalUsage.promptTokens + result.usage.promptTokens,
        completionTokens: totalUsage.completionTokens + result.usage.completionTokens,
      };
    }
    const turn = result.data;
    messages.push({ role: "user", content: `ASSISTANT_TURN:\n${result.raw}` });

    if (turn.action === "check_words") {
      toolCalls += 1;
      trace.push(`t${t}=check_words(${turn.words.length})`);
      const lines = turn.words.map(
        (w) => `${w.toLowerCase()}=${classifyWord(w.toLowerCase(), ledger, ctx.vocabEstimate, opts.rankOf)}`,
      );
      messages.push({
        role: "user",
        content: `TOOL_RESULT check_words:\n${lines.join("\n")}\n${turnBudgetNote(t)}`,
      });
      continue;
    }
    if (turn.action === "check_draft") {
      toolCalls += 1;
      const report = checkDraft(turn.text, ctx);
      trace.push(`t${t}=check_draft(pass=${report.pass})`);
      if (report.pass) {
        chosen = { turn: synthesizeSubmit(turn.text), report };
        break;
      }
      const score = scoreReport(report, targetHi);
      if (!best || score < best.score) best = { turn: synthesizeSubmit(turn.text), report, score };
      messages.push({
        role: "user",
        content: `TOOL_RESULT check_draft:\n${JSON.stringify(report)}\n${turnBudgetNote(t)}`,
      });
      continue;
    }

    const report = checkDraft(turn.text, ctx);
    trace.push(`t${t}=submit(pass=${report.pass})`);
    if (report.pass) {
      chosen = { turn, report };
      break;
    }
    const score = scoreReport(report, targetHi);
    if (!best || score < best.score) best = { turn, report, score };
    messages.push({
      role: "user",
      content:
        `TOOL_RESULT submit: REJECTED — fix the failures locally instead of rewriting.\n` +
        `${JSON.stringify(report)}\n${turnBudgetNote(t)}`,
    });
  }

  const final = chosen ?? best;
  if (!final) {
    storage.insertJournal({
      userId,
      scale: "generate",
      promptVersion: PROMPT_VERSIONS.generate,
      model: lastModel,
      inputSummary,
      rawResponse: lastRaw,
      delta: {
        error: { from: null, to: "no_draft_seen" },
        turns: { from: null, to: turns },
        tool_calls: { from: null, to: toolCalls },
        trace: { from: null, to: trace },
      },
      usage: sawUsage ? totalUsage : null,
      createdAt: new Date().toISOString(),
    });
    throw new GeneratorError(
      `generator produced no submittable draft within ${maxTurns} turns; trace: ${trace.join(" ")}`,
    );
  }
  const warnings: string[] = chosen
    ? []
    : [
        `max turns (${maxTurns}) reached without a passing draft; returning best-effort material`,
        ...final.report.failures.map((f) => `unresolved: ${f}`),
      ];

  const material: MaterialMeta & { text: string } = {
    material_id: opts.materialId ?? `gen-${userId}-${Date.now()}`,
    topics: final.turn.topics,
    difficulty: spec.band,
    length_words: final.report.length_words,
    summary: final.turn.summary,
    text: final.turn.text,
  };
  storage.saveMaterial(material);
  storage.insertJournal({
    userId,
    scale: "generate",
    promptVersion: PROMPT_VERSIONS.generate,
    model: lastModel,
    inputSummary,
    rawResponse: lastRaw,
    delta: {
      turns: { from: null, to: turns },
      tool_calls: { from: null, to: toolCalls },
      pass: { from: null, to: final.report.pass },
      failures: { from: null, to: final.report.failures },
    },
    usage: sawUsage ? totalUsage : null,
    createdAt: new Date().toISOString(),
  });

  return { material, new_items: final.report.new_items, turns, warnings, report: final.report };
}
