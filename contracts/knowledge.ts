import { z } from "zod";

export const KNOWLEDGE_STATES = ["new", "supported", "familiar", "mastered", "fading"] as const;
export const KnowledgeStateSchema = z.enum(KNOWLEDGE_STATES);
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

export const KnowledgeItemSchema = z.object({
  item: z.string(),
  item_type: z.enum(["word", "phrase"]),
  state: KnowledgeStateSchema,
  lookup_count: z.number().int().min(0),
  exposure_count: z.number().int().min(0),
  first_seen: z.string(),
  last_seen: z.string(),
  last_lookup_ts: z.string().nullable(),
  last_lookup_session: z.string().nullable(),
  next_review: z.string().nullable(),
  note: z.string().nullable(),
  sample_contexts: z.array(z.string()).describe("最近 1-2 个出现句子，供生成引擎重现时参考"),
});

export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

export const KnowledgeChangeSchema = z.object({
  user_id: z.string(),
  session_id: z.string().nullable(),
  item: z.string(),
  from_state: KnowledgeStateSchema.nullable(),
  to_state: KnowledgeStateSchema,
  trigger: z.enum(["lookup", "known", "exposure", "llm_annotation"]),
  note: z.string().nullable(),
  ts: z.string(),
});

export type KnowledgeChange = z.infer<typeof KnowledgeChangeSchema>;
