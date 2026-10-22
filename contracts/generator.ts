import { z } from "zod";
import { MaterialMetaSchema } from "./events";

// ---------------------------------------------------------------------------
// 组件 2 生成 loop 的结构化回合：LLM 每轮只输出一个动作（判别联合），
// 驱动代码确定性执行后以 TOOL_RESULT 回传。裁决权在代码，LLM 只提议。
// ---------------------------------------------------------------------------

export const CHECK_WORDS_LIMIT = 50;

export const CheckWordsTurnSchema = z.object({
  action: z.literal("check_words"),
  words: z.array(z.string()).max(CHECK_WORDS_LIMIT).describe("打草稿时不确定熟悉度的候选词"),
});

export const CheckDraftTurnSchema = z.object({
  action: z.literal("check_draft"),
  text: z.string().describe("请求整篇体检的草稿"),
});

export const SubmitTurnSchema = z.object({
  action: z.literal("submit"),
  text: z.string(),
  summary: z.string(),
  topics: z.array(z.string()).min(1),
  new_items: z.array(z.string()).describe("自报引入的新词，与代码判定对照"),
});

export const GeneratorTurnSchema = z.discriminatedUnion("action", [
  CheckWordsTurnSchema,
  CheckDraftTurnSchema,
  SubmitTurnSchema,
]);

// ---------------------------------------------------------------------------
// 确定性体检报告（checkDraft 的输出，既是工具结果也是验收闸门）
// ---------------------------------------------------------------------------

export const ReviewCoverageSchema = z.object({
  item: z.string(),
  present: z.boolean(),
});

export const DraftReportSchema = z.object({
  length_words: z.number().int(),
  length_ok: z.boolean(),
  predicted_lookup_rate: z
    .number()
    .describe("硬生词（stretch/untracked/账本 new）token 占比；review 词是刻意重现，不计入"),
  coverage_ok: z.boolean(),
  new_items: z.array(z.string()).describe("判定的不同硬生词（stretch + untracked）"),
  new_items_used: z.number().int(),
  new_item_budget: z.number().int(),
  budget_ok: z.boolean(),
  review_coverage: z.array(ReviewCoverageSchema),
  review_occurrences: z.number().int().describe("supported/fading 旧词出现次数（信息项）"),
  review_ok: z.boolean(),
  avoid_violations: z.array(z.string()),
  untracked_items: z.array(z.string()).describe("账本与词表都无法判定的词，保守计为 stretch"),
  pass: z.boolean(),
  failures: z.array(z.string()),
});

export const GeneratedMaterialSchema = z.object({
  material: MaterialMetaSchema.extend({ text: z.string() }),
  new_items: z.array(z.string()),
  turns: z.number().int(),
  warnings: z.array(z.string()),
  report: DraftReportSchema,
});

export type GeneratorTurn = z.infer<typeof GeneratorTurnSchema>;
export type CheckWordsTurn = z.infer<typeof CheckWordsTurnSchema>;
export type SubmitTurn = z.infer<typeof SubmitTurnSchema>;
export type DraftReport = z.infer<typeof DraftReportSchema>;
export type GeneratedMaterial = z.infer<typeof GeneratedMaterialSchema>;
