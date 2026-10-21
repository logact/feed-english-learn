// 合成词表：word0001..word8000，编号即难度 rank（词频序，越大越难）。
// 画像真值 trueVocab=N 表示「认识 rank<N 的词」。
export const LEXICON_SIZE = 8000;

export function wordAt(rank: number): string {
  const r = Math.max(1, Math.min(LEXICON_SIZE, Math.round(rank)));
  return `word${String(r).padStart(4, "0")}`;
}

export function rankOf(word: string): number | null {
  const m = word.match(/^word(\d{4})$/);
  return m ? parseInt(m[1], 10) : null;
}

export function bandOf(vocab: number): string {
  if (vocab < 1000) return "A1";
  if (vocab < 2000) return "A2";
  if (vocab < 3500) return "B1";
  if (vocab < 5500) return "B2";
  if (vocab < 7000) return "C1";
  return "C2";
}
