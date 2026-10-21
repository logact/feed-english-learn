// 剧本化事件流生成：给定画像与随机种子，生成一个 session 的 ReadingEvent 序列。
// 材料：~96% 已知区词汇 + ~4% 拉伸区词汇（N+1），外加旧词重现（review words）。
// 行为：rank > trueVocab 的词大概率查；认识的词小概率误查；不认识的词小概率猜出跳过。
import type { ReadingEvent } from "../contracts/events";
import { wordAt, rankOf } from "./lexicon";
import type { Persona } from "./personas";

export interface GeneratedSession {
  sessionId: string;
  events: ReadingEvent[];
  /** 本 session 中用户真实会查的词（评估用真值） */
  trueLookups: string[];
  materialId: string;
}

const BASE_TS = Date.parse("2026-01-01T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionHistory {
  /** 之前 session 查过的词（供旧词重现） */
  previouslyLookedUp: string[];
  /** 之前 session 主动标记认识的词（遗忘者剧本：回归后重现以验证 fading 复活） */
  knownWords: string[];
}

export function sessionStartTs(persona: Persona, sessionIdx: number): number {
  let t = BASE_TS;
  for (let i = 1; i <= sessionIdx; i++) t += persona.gapDays(i) * DAY_MS;
  return t;
}

export function generateSession(
  persona: Persona,
  sessionIdx: number,
  rng: () => number,
  history: SessionHistory,
): GeneratedSession {
  const userId = `sim-${persona.id}`;
  const sessionId = `s${sessionIdx}`;
  const materialId = `m-${persona.id}-${sessionIdx}`;
  const ts = sessionStartTs(persona, sessionIdx);
  const iso = (offsetMs: number) => new Date(ts + offsetMs).toISOString();

  const length = persona.materialLength(sessionIdx);
  const matRank = persona.materialRank(sessionIdx);

  // --- 组词 ---
  const words: string[] = [];
  const stretchCount = Math.max(3, Math.round(length * 0.04));
  for (let i = 0; i < length - stretchCount; i++) {
    // 已知区：rank 在 [0.3V, 0.98V]
    const r = persona.trueVocab * 0.3 + rng() * persona.trueVocab * 0.68;
    words.push(wordAt(r));
  }
  for (let i = 0; i < stretchCount; i++) {
    words.push(wordAt(matRank + rng() * 300));
  }
  // 旧词重现（含查过的词与标记认识的词）
  const reviewPool = [...history.previouslyLookedUp, ...history.knownWords].filter((w) => {
    const r = rankOf(w);
    return r !== null && r < matRank + 300; // 避免遗忘者剧本里出现过难的词
  });
  const reviewWords: string[] = [];
  const forgottenWords = new Set<string>(); // 来自 knownWords 的重现词（可能被遗忘回查）
  for (let i = 0; i < persona.reviewWordCount(sessionIdx) && reviewPool.length > 0; i++) {
    const w = reviewPool[Math.floor(rng() * reviewPool.length)];
    reviewWords.push(w);
    if (history.knownWords.includes(w)) forgottenWords.add(w);
  }
  words.push(...reviewWords);

  // 打乱并拼成伪句子
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }
  const sentences: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    sentences.push(words.slice(i, i + 12).join(" ") + ".");
  }
  const text = sentences.join(" ");

  // --- 行为模拟 ---
  const topics = persona.topics(sessionIdx);
  const events: ReadingEvent[] = [];
  const trueLookups: string[] = [];

  events.push({
    type: "session_start",
    user_id: userId,
    session_id: sessionId,
    ts: iso(0),
    material: {
      material_id: materialId,
      topics,
      difficulty: `rank~${matRank}`,
      length_words: words.length,
      summary: `synthetic material on ${topics.join(",")}`,
      text,
    },
  });

  const sentenceOf = new Map<string, string>();
  for (const s of sentences) {
    for (const w of s.split(/[\s.]+/)) if (!sentenceOf.has(w)) sentenceOf.set(w, s);
  }

  let clock = 60_000; // 开始阅读 1 分钟后
  for (const w of words) {
    const rank = rankOf(w)!;
    const unknown = rank > persona.trueVocab;
    let lookup = false;
    if (forgottenWords.has(w)) {
      // 遗忘回查：曾经认识的词空窗后被重新查询
      lookup = rng() < persona.forgottenLookupProb(sessionIdx);
    } else if (unknown) lookup = rng() > persona.noiseSkipUnknown;
    else lookup = rng() < persona.noiseLookupKnown;
    if (lookup && !trueLookups.includes(w)) {
      trueLookups.push(w);
      events.push({
        type: "word_lookup",
        user_id: userId,
        session_id: sessionId,
        ts: iso(clock),
        lemma: w,
        item_type: "word",
        sentence: sentenceOf.get(w) ?? w,
      });
      clock += 15_000; // 查词耗时
    }
  }

  // 主动标记认识（word_known）：从已知区选词
  const markKnown = persona.markKnownCount(sessionIdx);
  for (let i = 0; i < markKnown; i++) {
    const w = wordAt(persona.trueVocab * 0.5 + rng() * persona.trueVocab * 0.3);
    events.push({
      type: "word_known",
      user_id: userId,
      session_id: sessionId,
      ts: iso(clock),
      lemma: w,
    });
    clock += 1_000;
  }

  // 完成/放弃：生词率 >8% → 放弃（约 40% 处）
  const unknownRatio =
    words.filter((w) => rankOf(w)! > persona.trueVocab).length / words.length;
  const wordsRead = words.length;
  const wpm = persona.trueWpm * (0.9 + rng() * 0.2);
  const fullDuration = Math.round((wordsRead / wpm) * 60_000);
  if (unknownRatio > 0.08) {
    events.push({
      type: "material_abandoned",
      user_id: userId,
      session_id: sessionId,
      ts: iso(clock + fullDuration * 0.4),
      material_id: materialId,
      completion_rate: 0.4,
      duration_ms: Math.round(fullDuration * 0.4),
      words_read: Math.round(wordsRead * 0.4),
    });
  } else {
    events.push({
      type: "material_completed",
      user_id: userId,
      session_id: sessionId,
      ts: iso(clock + fullDuration),
      material_id: materialId,
      completion_rate: 1,
      duration_ms: fullDuration,
      words_read: wordsRead,
    });
    // 兴趣正反馈
    if (rng() < 0.7) {
      events.push({
        type: "feedback",
        user_id: userId,
        session_id: sessionId,
        ts: iso(clock + fullDuration + 1000),
        material_id: materialId,
        sentiment: "like",
        topic: topics[0],
      });
    }
  }

  events.push({
    type: "session_end",
    user_id: userId,
    session_id: sessionId,
    ts: iso(clock + fullDuration + 2000),
  });

  return { sessionId, events, trueLookups, materialId };
}

export function generatePersonaEvents(
  persona: Persona,
  seed = 42,
): { sessions: GeneratedSession[] } {
  // 简单 LCG 包装外部 rng 不可行，这里由调用方传 rng；本函数用独立种子
  let s = seed >>> 0;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const history: SessionHistory = { previouslyLookedUp: [], knownWords: [] };
  const sessions: GeneratedSession[] = [];
  for (let i = 0; i < persona.sessions; i++) {
    const session = generateSession(persona, i, rng, history);
    history.previouslyLookedUp.push(...session.trueLookups);
    for (const ev of session.events) {
      if (ev.type === "word_known") history.knownWords.push(ev.lemma);
    }
    sessions.push(session);
  }
  return { sessions };
}
