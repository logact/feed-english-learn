import { z } from "zod";
import { BandSchema } from "./profile";
import { KnowledgeStateSchema } from "./knowledge";

// 组件 2「材料生成引擎」的消费接口：分层状态的读取方式。
export const ReviewItemSchema = z.object({
  item: z.string(),
  state: KnowledgeStateSchema,
  sample_context: z.string().nullable(),
});

export const TargetSpecSchema = z.object({
  user_id: z.string(),
  band: BandSchema.describe("整体难度锚点"),
  length_words: z.tuple([z.number().int(), z.number().int()]).describe("篇幅区间"),
  topics: z.array(z.string()).describe("兴趣按权重排序"),
  review_items: z.array(ReviewItemSchema).describe("需重现的旧知识（fading/supported）"),
  new_item_budget: z.number().int().min(0).describe("允许引入的新词数（对应 95~98% 覆盖率）"),
  avoid_items: z.array(z.string()).describe("new 状态且用户已显挫折的词，暂缓重现"),
  notes: z.string(),
  generated_at: z.string(),
});

export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export type TargetSpec = z.infer<typeof TargetSpecSchema>;
