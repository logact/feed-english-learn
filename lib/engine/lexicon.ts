// 真实英文词频表：scripts/build-lexicon.py 离线生成（wordfreq，CC BY-SA 4.0）。
// ranks 数组下标 + 1 即 rank；查询时用规则词形候选取最小 rank（等价于粗略 lemma 归并：
// cats→cat、cities→city、running→run），常见变形词自身也在表中，取 min 即可。
// 表文件缺失时退化为全 null（纯 sim / 账本判定），保证无词表环境可跑通。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rankOf as simRankOf } from "../../sim/lexicon";

let table: Map<string, number> | undefined;

function loadTable(): Map<string, number> {
  if (table !== undefined) return table;
  const p = join(/* turbopackIgnore: true */ process.cwd(), "lib/engine/lexicon-en.json");
  if (!existsSync(p)) {
    table = new Map();
    return table;
  }
  const data = JSON.parse(readFileSync(p, "utf8")) as { ranks: string[] };
  table = new Map(data.ranks.map((w, i) => [w, i + 1]));
  return table;
}

/** 词形候选：原词 + 规则变形（复数/过去式/现在分词），查表时取所有命中者的最小 rank */
export function rankCandidates(w: string): string[] {
  const out = [w];
  const add = (c: string) => {
    if (c.length > 1 && !out.includes(c)) out.push(c);
  };
  if (w.endsWith("'s")) add(w.slice(0, -2));
  if (w.endsWith("ies") && w.length > 3) add(`${w.slice(0, -3)}y`); // cities → city
  if (w.endsWith("es") && w.length > 2) add(w.slice(0, -2)); // boxes → box
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 2) add(w.slice(0, -1)); // cats → cat
  if (w.endsWith("ed") && w.length > 3) {
    add(w.slice(0, -2)); // played → play
    add(w.slice(0, -1)); // baked → bake
  }
  if (w.endsWith("ing") && w.length > 4) {
    const stem = w.slice(0, -3);
    add(stem); // playing → play
    add(`${stem}e`); // making → make
    if (/(.)\1$/.test(stem)) add(stem.slice(0, -1)); // running → runn → run
  }
  return out;
}

export function rankOfEn(word: string): number | null {
  const t = loadTable();
  let best: number | null = null;
  for (const c of rankCandidates(word.toLowerCase())) {
    const r = t.get(c);
    if (r !== undefined && (best === null || r < best)) best = r;
  }
  return best;
}

/** 默认 rank 源：sim 合成词（wordNNNN）优先，其次真实英文表；两者互斥不冲突 */
export function defaultRankOf(word: string): number | null {
  return simRankOf(word) ?? rankOfEn(word);
}
