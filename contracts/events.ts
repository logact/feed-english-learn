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
  sentiment: z.enum(["like", "dislike"]),
  topic: z.string().optional(),
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
