// 五个合成画像（带真值与噪声注入）。
// 每个画像描述：真实词汇量、阅读速度、兴趣（可漂移）、材料供给策略、行为噪声。
export interface Persona {
  id: string;
  description: string;
  /** 真值：认识的词 rank < trueVocab */
  trueVocab: number;
  /** 真值：阅读速度 wpm */
  trueWpm: number;
  sessions: number;
  /** 本 session 的兴趣话题 */
  topics(sessionIdx: number): string[];
  /** 本 session 材料难度中心 rank（材料生成引擎的供给） */
  materialRank(sessionIdx: number): number;
  /** 本 session 材料篇幅 */
  materialLength(sessionIdx: number): number;
  /** session i 距上一 session 的天数（遗忘者用它制造时间跳跃） */
  gapDays(sessionIdx: number): number;
  /** 已掌握旧词在本 session 材料中重现的数量（遗忘者用它验证复活） */
  reviewWordCount(sessionIdx: number): number;
  /** 本 session 主动标记认识（word_known）的词数（遗忘者用它快速建立 mastered 条目） */
  markKnownCount(sessionIdx: number): number;
  /** 已标记认识的旧词在本 session 被重新查询的概率（遗忘曲线：空窗后回查） */
  forgottenLookupProb(sessionIdx: number): number;
  /** 噪声：认识但仍查的概率 */
  noiseLookupKnown: number;
  /** 噪声：不认识但靠上下文猜出而不查的概率 */
  noiseSkipUnknown: number;
}

export const PERSONAS: Persona[] = [
  {
    id: "beginner",
    description: "初学者：真值 1500 词，材料供给在 N+1（rank≈1500）",
    trueVocab: 1500,
    trueWpm: 100,
    sessions: 12,
    topics: () => ["technology"],
    materialRank: () => 1500,
    materialLength: () => 350,
    gapDays: () => 1,
    reviewWordCount: () => 3,
    markKnownCount: () => 0,
    forgottenLookupProb: () => 0,
    noiseLookupKnown: 0.01,
    noiseSkipUnknown: 0.25,
  },
  {
    id: "advanced",
    description: "进阶者：真值 5000 词，检验不被冷启动锚定",
    trueVocab: 5000,
    trueWpm: 150,
    sessions: 12,
    topics: () => ["science"],
    materialRank: () => 5000,
    materialLength: () => 500,
    gapDays: () => 1,
    reviewWordCount: () => 3,
    markKnownCount: () => 0,
    forgottenLookupProb: () => 0,
    noiseLookupKnown: 0.01,
    noiseSkipUnknown: 0.25,
  },
  {
    id: "interest-drift",
    description: "兴趣漂移：前 6 个 session 科技，后 6 个体育",
    trueVocab: 3000,
    trueWpm: 120,
    sessions: 12,
    topics: (i) => (i < 6 ? ["technology"] : ["sports"]),
    materialRank: () => 3000,
    materialLength: () => 400,
    gapDays: () => 1,
    reviewWordCount: () => 3,
    markKnownCount: () => 0,
    forgottenLookupProb: () => 0,
    noiseLookupKnown: 0.01,
    noiseSkipUnknown: 0.25,
  },
  {
    id: "forgetter",
    description: "遗忘者：4 个 session 后中断 35 天，再回归 4 个 session（旧词重现）",
    trueVocab: 2500,
    trueWpm: 110,
    sessions: 8,
    topics: () => ["culture"],
    materialRank: () => 2500,
    materialLength: () => 400,
    gapDays: (i) => (i === 4 ? 35 : 1),
    reviewWordCount: (i) => (i >= 4 ? 8 : 3), // 回归后材料大量重现旧词
    markKnownCount: (i) => (i < 4 ? 5 : 0), // 前 4 个 session 各标记 5 个词为认识
    forgottenLookupProb: (i) => (i >= 4 ? 0.85 : 0), // 空窗 35 天后已遗忘大半
    noiseLookupKnown: 0.01,
    noiseSkipUnknown: 0.25,
  },
  {
    id: "oscillator",
    description: "震荡压力：材料难度交替过难（rank 5000）/过易（rank 1000）",
    trueVocab: 3000,
    trueWpm: 120,
    sessions: 12,
    topics: () => ["technology"],
    materialRank: (i) => (i % 2 === 0 ? 5000 : 1000),
    materialLength: () => 400,
    gapDays: () => 1,
    reviewWordCount: () => 2,
    markKnownCount: () => 0,
    forgottenLookupProb: () => 0,
    noiseLookupKnown: 0.01,
    noiseSkipUnknown: 0.25,
  },
];

export function personaById(id: string): Persona {
  const p = PERSONAS.find((p) => p.id === id);
  if (!p) throw new Error(`unknown persona: ${id}`);
  return p;
}
