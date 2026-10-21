import { z } from "zod";

export const BANDS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export const BandSchema = z.enum(BANDS);
export type Band = (typeof BANDS)[number];

export const ReadingStateSchema = z.object({
  band: BandSchema.describe("整体水平，仅阶段检查（尺度3）可调整"),
  vocab_estimate: z.number().int().positive().describe("词汇量估计，仅阶段检查可调整"),
  confidence: z.number().min(0).max(1),
  target_lookup_rate: z
    .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
    .describe("目标查词率区间，对应 95~98% 覆盖率目标"),
  comfortable_length_words: z.number().int().positive(),
  max_length_words: z.number().int().positive(),
  reading_speed_wpm: z.number().int().positive(),
  sessions_since_review: z.number().int().min(0).describe("距上次阶段检查的 session 数"),
  evidence: z.string().describe("LLM 必须写出的判断依据，引用 digest 中的具体数字"),
});

export const InterestSchema = z.object({
  topic: z.string(),
  weight: z.number().min(0).max(1),
  note: z.string().describe("兴趣的细微差别备注"),
});

export const UserProfileSchema = z.object({
  user_id: z.string(),
  version: z.number().int().min(0),
  reading_state: ReadingStateSchema,
  interests: z.array(InterestSchema),
  notes: z.string().describe("LLM 维护的自由文本压缩记忆"),
  updated_at: z.string(),
});

export type ReadingState = z.infer<typeof ReadingStateSchema>;
export type Interest = z.infer<typeof InterestSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;

// ---------------------------------------------------------------------------
// 尺度 2（session 级）LLM 输出契约。
// 结构性防震荡：schema 中直接不存在 band / vocab_estimate 字段，
// LLM 在该尺度下物理上无法改动整体水平。
// ---------------------------------------------------------------------------

export const KNOWLEDGE_ANNOTATION_MAX = 20;

export const KnowledgeAnnotationSchema = z.object({
  item: z.string(),
  suggest_state: z.enum(["new", "supported", "familiar", "mastered", "fading"]),
  note: z.string(),
});

export const ProfileSessionUpdateSchema = z.object({
  reading_state: z
    .object({
      confidence: z.number().min(0).max(1).optional(),
      target_lookup_rate: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
      comfortable_length_words: z.number().int().positive().optional(),
      max_length_words: z.number().int().positive().optional(),
      reading_speed_wpm: z.number().int().positive().optional(),
      evidence: z.string(),
    })
    .strict(),
  interests: z.array(InterestSchema),
  notes: z.string(),
  knowledge_annotations: z.array(KnowledgeAnnotationSchema).max(KNOWLEDGE_ANNOTATION_MAX).default([]),
});

export type KnowledgeAnnotation = z.infer<typeof KnowledgeAnnotationSchema>;
export type ProfileSessionUpdate = z.infer<typeof ProfileSessionUpdateSchema>;

// ---------------------------------------------------------------------------
// 尺度 3（阶段检查）LLM 输出契约：允许动 band / vocab_estimate，
// 但幅度与方向由代码 gate（滞回 + 一致性证据）约束。
// ---------------------------------------------------------------------------

export const StageReviewOutputSchema = z.object({
  adjust: z.boolean().describe("是否调整 band / vocab_estimate"),
  band: BandSchema.optional(),
  vocab_estimate: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().describe("必须引用最近若干 session digest 的具体数字"),
});

export type StageReviewOutput = z.infer<typeof StageReviewOutputSchema>;

// 第 3 层评估：预测用户在一篇新材料中会查哪些词
export const LookupPredictionSchema = z.object({
  likely_lookups: z.array(z.string()),
  reasoning: z.string(),
});

export type LookupPrediction = z.infer<typeof LookupPredictionSchema>;

export function defaultProfile(userId: string, now: string): UserProfile {
  return {
    user_id: userId,
    version: 0,
    reading_state: {
      band: "A2",
      vocab_estimate: 2000,
      confidence: 0.1,
      target_lookup_rate: [0.02, 0.05],
      comfortable_length_words: 300,
      max_length_words: 500,
      reading_speed_wpm: 120,
      sessions_since_review: 0,
      evidence: "cold start default, no behavior observed yet",
    },
    interests: [],
    notes: "",
    updated_at: now,
  };
}
