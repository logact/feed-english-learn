// 组件 2 闭环评估：persona 训练 80% session 后，反复执行完整自适应循环——
//   生成材料 → 真值模拟阅读（rank > trueVocab 首现即查，>8% 则 40% 处放弃）
//   → 行为事件回流引擎（账本/画像更新）→ 下一轮生成。
//  verdict 口径与 textcheck 一致：硬词查词密度（排除刻意重现的 supported/fading 词）。
//  合成词表下全程确定性：固定 MockLLMClient。真实英文生成需接入真实频率词表。
//
// CLI: `pnpm sim:gen [personaId] [rounds]`
import { createEngine } from "../lib/engine/engine";
import { createStorage } from "../lib/engine/storage";
import { MockLLMClient } from "../lib/engine/llm";
import { effectiveState } from "../lib/engine/knowledge";
import { tokenize } from "../lib/engine/textcheck";
import type { ReadingEvent } from "../contracts/events";
import { rankOf } from "./lexicon";
import { personaById } from "./personas";
import { generatePersonaEvents } from "./generator";

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
  const personaId = process.argv[2] ?? "beginner";
  const rounds = parseInt(process.argv[3] ?? "6", 10);
  const persona = personaById(personaId);
  const llm = new MockLLMClient();
  console.log(`persona=${persona.id} (trueVocab=${persona.trueVocab}) generator=${llm.modelName()} rounds=${rounds}`);

  const { sessions } = generatePersonaEvents(persona, 42);
  const split = Math.max(1, Math.floor(sessions.length * 0.8));
  const train = sessions.slice(0, split);

  const storage = createStorage(":memory:");
  const engine = createEngine({ storage, llm });
  for (const s of train) {
    for (const ev of s.events) await engine.processEvent(ev);
  }

  const userId = `sim-${persona.id}`;
  let clock = Date.parse(storage.lastEventTs(userId)!) + DAY_MS;
  // 验收口径：round 1 视为冷启动校准轮；其后的材料硬词密度不得超过目标上界
  // （低于下界只说明偏易，是软问题，打印但不判失败）。
  let postCalibrationOk = true;

  for (let r = 1; r <= rounds; r++) {
    const before = engine.getProfile(userId).reading_state;
    const gen = await engine.generateMaterial(userId, {
      materialId: `gen-eval-${persona.id}-${r}`,
    });
    const sessionTs = new Date(clock).toISOString();
    const [lo, hi] = before.target_lookup_rate;

    // 阅读时刻的账本快照（判定 review 词用）
    const ledger = new Map(
      storage.listKnowledgeItems(userId).map((it) => [it.item, effectiveState(it, sessionTs)] as const),
    );

    // 真值模拟阅读：未知词首现即查（确定性，无噪声）
    const tokens = tokenize(gen.material.text);
    const firstUnknown = new Map<string, number>();
    tokens.forEach((w, i) => {
      const rk = rankOf(w);
      if (rk !== null && rk > persona.trueVocab && !firstUnknown.has(w)) firstUnknown.set(w, i);
    });
    const rawDensity = firstUnknown.size / tokens.length;
    const abandoned = rawDensity > 0.08;
    const wordsRead = abandoned ? Math.floor(tokens.length * 0.4) : tokens.length;
    const lookups = [...firstUnknown.entries()].filter(([, i]) => i < wordsRead);
    const hardLookups = lookups.filter(([w]) => {
      const st = ledger.get(w);
      return st !== "supported" && st !== "fading";
    });
    const hardDensity = hardLookups.length / wordsRead;
    const inBand = hardDensity >= lo && hardDensity <= hi;
    const marker = inBand ? "IN ✓" : hardDensity > hi ? "TOO HARD ✗" : "easy (below lo)";

    // 事件回流（行为 → 引擎更新账本/画像）
    const iso = (offset: number) => new Date(clock + offset).toISOString();
    const sessionId = `gen-s${r}`;
    const sentences = gen.material.text.match(/[^.!?]+[.!?]/g) ?? [gen.material.text];
    const sentenceOf = (w: string) => sentences.find((s) => s.toLowerCase().includes(w)) ?? w;
    const events: ReadingEvent[] = [
      {
        type: "session_start",
        user_id: userId,
        session_id: sessionId,
        ts: iso(0),
        material: gen.material,
      },
    ];
    let offset = 60_000;
    for (const [w] of lookups) {
      events.push({
        type: "word_lookup",
        user_id: userId,
        session_id: sessionId,
        ts: iso(offset),
        lemma: w,
        item_type: "word",
        sentence: sentenceOf(w).trim(),
      });
      offset += 15_000;
    }
    events.push(
      abandoned
        ? {
            type: "material_abandoned",
            user_id: userId,
            session_id: sessionId,
            ts: iso(offset),
            material_id: gen.material.material_id,
            completion_rate: 0.4,
            duration_ms: offset,
            words_read: wordsRead,
          }
        : {
            type: "material_completed",
            user_id: userId,
            session_id: sessionId,
            ts: iso(offset),
            material_id: gen.material.material_id,
            completion_rate: 1,
            duration_ms: offset,
            words_read: wordsRead,
          },
      { type: "session_end", user_id: userId, session_id: sessionId, ts: iso(offset + 1000) },
    );
    for (const ev of events) await engine.processEvent(ev);

    const after = engine.getProfile(userId).reading_state;
    console.log(
      `round ${r}: est ${before.vocab_estimate}→${after.vocab_estimate} band=${after.band} ` +
        `len=${gen.report.length_words} new=${gen.report.new_items_used}/${gen.report.new_item_budget} ` +
        `pass=${gen.report.pass} raw=${(rawDensity * 100).toFixed(1)}%${abandoned ? "(abandoned)" : ""} ` +
        `hard=${(hardDensity * 100).toFixed(1)}% target=[${(lo * 100).toFixed(0)}%,${(hi * 100).toFixed(0)}%] ${marker}`,
    );
    if (r >= 2 && hardDensity > hi) postCalibrationOk = false;
    clock += DAY_MS;
  }

  console.log(
    postCalibrationOk
      ? "converged: no post-calibration round above target hi ✓"
      : "post-calibration round exceeded target hi ✗",
  );
  if (!postCalibrationOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
