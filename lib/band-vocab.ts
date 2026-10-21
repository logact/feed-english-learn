import type { Band } from "../contracts/profile";

// 自评档位 → 初始词汇量估计(onboarding 建档与 reassess 重置共用)
export const BAND_VOCAB: Record<Band, number> = {
  A1: 800,
  A2: 2000,
  B1: 3500,
  B2: 6000,
  C1: 9000,
  C2: 12000,
};
