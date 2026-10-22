import { z } from "zod";

// 生成引擎提供，本引擎只消费。text 可选：提供时用于确定性计算知识点曝光。
export const MaterialMetaSchema = z.object({
  material_id: z.string(),
  topics: z.array(z.string()),
  difficulty: z.string().describe("难度描述，如 band 提示"),
  length_words: z.number().int().positive(),
  summary: z.string().describe("正文摘要"),
  text: z.string().optional().describe("正文全文（可选），用于知识点曝光记账"),
});

export type MaterialMeta = z.infer<typeof MaterialMetaSchema>;

const base = {
  user_id: z.string(),
  session_id: z.string(),
  ts: z.string().describe("ISO 时间戳，引擎以事件时间为准（可复现回放）"),
  event_id: z
    .string()
    .optional()
    .describe("客户端生成的幂等键；重试必须复用同一 event_id，服务端按 (user_id, event_id) 去重"),
};

export const SessionStartEventSchema = z.object({
  ...base,
  type: z.literal("session_start"),
  material: MaterialMetaSchema,
});

export const SessionEndEventSchema = z.object({
  ...base,
  type: z.literal("session_end"),
});

export const WordLookupEventSchema = z.object({
  ...base,
  type: z.literal("word_lookup"),
  lemma: z.string(),
  item_type: z.enum(["word", "phrase"]).default("word"),
  sentence: z.string(),
});

export const WordKnownEventSchema = z.object({
  ...base,
  type: z.literal("word_known"),
  lemma: z.string(),
});

export const MaterialCompletedEventSchema = z.object({
  ...base,
  type: z.literal("material_completed"),
  material_id: z.string(),
  completion_rate: z.number().min(0).max(1),
  duration_ms: z.number().int().min(0),
  words_read: z.number().int().min(0),
});

export const MaterialAbandonedEventSchema = z.object({
  ...base,
  type: z.literal("material_abandoned"),
  material_id: z.string(),
  completion_rate: z.number().min(0).max(1),
  duration_ms: z.number().int().min(0),
  words_read: z.number().int().min(0),
});

export const FeedbackEventSchema = z.object({
  ...base,
  type: z.literal("feedback"),
  material_id: z.string(),
  sentiment: z.enum(["like", "dislike"]).optional(),
  topic: z.string().optional(),
  difficulty: z
    .enum(["too_easy", "just_right", "too_hard"])
    .optional()
    .describe("难度显式反馈;阶段检查滞回 gate 的辅助信号"),
});

export const ReadingEventSchema = z.discriminatedUnion("type", [
  SessionStartEventSchema,
  SessionEndEventSchema,
  WordLookupEventSchema,
  WordKnownEventSchema,
  MaterialCompletedEventSchema,
  MaterialAbandonedEventSchema,
  FeedbackEventSchema,
]);

export type ReadingEvent = z.infer<typeof ReadingEventSchema>;
export type ReadingEventType = ReadingEvent["type"];
