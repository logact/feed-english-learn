// digest：事件流 + 知识点变化 → 紧凑自然语言摘要（确定性，零 LLM 成本）。
// 输出格式带稳定 key=value 标签，既给 LLM 读，也可被 MockLLMClient 与测试机械解析。
import type { ReadingEvent } from "../../contracts/events";
import type { KnowledgeChange, KnowledgeItem } from "../../contracts/knowledge";
import type { MaterialMeta } from "../../contracts/events";

export interface SessionDigestInput {
  events: ReadingEvent[];
  material: MaterialMeta | null;
  knowledgeChanges: KnowledgeChange[];
}

export function buildSessionDigest(input: SessionDigestInput): string {
  const { events, material, knowledgeChanges } = input;
  const lines: string[] = [];

  const sessionId = events[0]?.session_id ?? "unknown";
  lines.push(`session_id=${sessionId}`);

  const lookups = events.filter((e) => e.type === "word_lookup");
  const knowns = events.filter((e) => e.type === "word_known");
  const feedbacks = events.filter((e) => e.type === "feedback");
  const completed = events.find((e) => e.type === "material_completed");
  const abandoned = events.find((e) => e.type === "material_abandoned");
  const outcome = completed ?? abandoned;

  if (material) {
    lines.push(
      `material_id=${material.material_id} topics=[${material.topics.join(",")}] ` +
        `difficulty=${material.difficulty} length_words=${material.length_words}`,
    );
  }

  const wordsRead = outcome?.words_read ?? material?.length_words ?? 0;
  const completionRate = outcome ? Math.round(outcome.completion_rate * 100) : 0;
  const durationMs = outcome?.duration_ms ?? 0;
  const wpm =
    durationMs > 0 && wordsRead > 0 ? Math.round(wordsRead / (durationMs / 60000)) : 0;

  lines.push(
    `words_read=${wordsRead} completion_rate=${completionRate}% duration_ms=${durationMs} ` +
      `reading_speed_wpm=${wpm} abandoned=${abandoned ? "true" : "false"}`,
  );

  const density = wordsRead > 0 ? (lookups.length / wordsRead) * 100 : 0;
  lines.push(`lookups=${lookups.length} lookup_density=${density.toFixed(2)}%`);

  if (lookups.length > 0) {
    const counts = new Map<string, number>();
    for (const l of lookups) {
      if (l.type === "word_lookup") counts.set(l.lemma, (counts.get(l.lemma) ?? 0) + 1);
    }
    lines.push(
      "lookup_items: " +
        [...counts.entries()].map(([w, c]) => `${w}×${c}`).join("; "),
    );
  }
  if (knowns.length > 0) {
    lines.push(
      "known_marked: " +
        knowns.map((k) => (k.type === "word_known" ? k.lemma : "")).filter(Boolean).join("; "),
    );
  }
  for (const f of feedbacks) {
    if (f.type === "feedback") {
      lines.push(`feedback: ${f.sentiment}${f.topic ? `(topic=${f.topic})` : ""}`);
    }
  }

  if (knowledgeChanges.length > 0) {
    const groups = new Map<string, string[]>();
    for (const c of knowledgeChanges) {
      const key = `${c.from_state ?? "null"}→${c.to_state}`;
      groups.set(key, [...(groups.get(key) ?? []), c.item]);
    }
    lines.push(
      "knowledge_changes: " +
        [...groups.entries()].map(([k, items]) => `${items.length} ${k} (${items.join(",")})`).join("; "),
    );
  } else {
    lines.push("knowledge_changes: none");
  }

  return lines.join("\n");
}

export interface KnowledgeSummary {
  total: number;
  byState: Record<string, number>;
  masteredLastK: number; // 最近 K 个 session 内进入 mastered 的词数
  fadingNow: number;
}

export function summarizeKnowledge(
  items: KnowledgeItem[],
  changes: KnowledgeChange[],
  recentSessionIds: Set<string>,
  now: string,
  effective: (item: KnowledgeItem, now: string) => string,
): KnowledgeSummary {
  const byState: Record<string, number> = {};
  let fadingNow = 0;
  for (const it of items) {
    const s = effective(it, now);
    byState[s] = (byState[s] ?? 0) + 1;
    if (s === "fading") fadingNow += 1;
  }
  const masteredLastK = changes.filter(
    (c) => c.to_state === "mastered" && c.session_id && recentSessionIds.has(c.session_id),
  ).length;
  return { total: items.length, byState, masteredLastK, fadingNow };
}

/** 尺度 3 输入：最近 K 次 session digest 序列 + 知识点层汇总 */
export function buildStageDigest(
  sessionDigests: string[],
  summary: KnowledgeSummary,
  k: number,
): string {
  const lines: string[] = [];
  lines.push(`stage_review: last ${sessionDigests.length} sessions (K=${k})`);
  lines.push(
    `knowledge_summary: total=${summary.total} ` +
      Object.entries(summary.byState)
        .map(([s, n]) => `${s}=${n}`)
        .join(" ") +
      ` mastered_recent=${summary.masteredLastK} fading_now=${summary.fadingNow}`,
  );
  sessionDigests.forEach((d, i) => {
    lines.push(`--- session_digest[${i}] ---`);
    lines.push(d);
  });
  return lines.join("\n");
}

/** 从 digest 文本解析查词密度（滞回判定用） */
export function parseLookupDensity(digest: string): number | null {
  const m = digest.match(/lookup_density=([\d.]+)%/);
  return m ? parseFloat(m[1]) : null;
}
