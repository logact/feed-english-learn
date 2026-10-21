// 第 3 层评估：留出集（后 20% session）预测用户会查哪些词。
// 两个变体：with-knowledge（profile + knowledge_items）vs profile-only。
// 分层建模有效的证据：with-knowledge 变体应显著更优（已知 fading/supported 词应被预测为可能查询）。
//
// CLI: `pnpm sim:eval [personaId]`
// 无 LLM_API_KEY 时用与 MockLLMClient 等价的确定性启发式预测器。
import { createEngine } from "../lib/engine/engine";
import { createStorage } from "../lib/engine/storage";
import { createLLMClient, MockLLMClient, type LLMClient } from "../lib/engine/llm";
import { LookupPredictionSchema } from "../contracts/profile";
import { effectiveState } from "../lib/engine/knowledge";
import { loadPrompt, PROMPT_VERSIONS } from "../lib/engine/profiler";
import { personaById } from "./personas";
import { generatePersonaEvents } from "./generator";
import { logLoss, prf1, lookupScore } from "./metrics";

async function predict(
  llm: LLMClient,
  useLlm: boolean,
  input: {
    vocabEstimate: number;
    candidates: string[];
    ledger: Map<string, string>; // word → effective state（with-knowledge 变体才传非空）
  },
): Promise<Set<string>> {
  if (!useLlm) {
    // 代码启发式（与 MockLLMClient 的 LookupPrediction 规则等价）
    const out = new Set<string>();
    for (const w of input.candidates) {
      if (lookupScore(w, input.vocabEstimate, input.ledger.get(w) ?? null) >= 0.5) out.add(w);
    }
    return out;
  }
  const fading = [...input.ledger.entries()].filter(([, s]) => s === "fading").map(([w]) => w);
  const result = await llm.complete({
    schemaName: "LookupPrediction",
    schema: LookupPredictionSchema,
    messages: [
      { role: "system", content: loadPrompt("predict_lookups") },
      {
        role: "user",
        content:
          `vocab_estimate=${input.vocabEstimate}\n` +
          `fading_items=[${fading.join(",")}]\n` +
          `candidate_words=[${input.candidates.join(",")}]`,
      },
    ],
  });
  return new Set(result.data.likely_lookups.map((w) => w.toLowerCase()));
}

async function main() {
  const personaId = process.argv[2] ?? "beginner";
  const persona = personaById(personaId);
  const llm = createLLMClient();
  const useLlm = !(llm instanceof MockLLMClient);
  console.log(`persona=${persona.id} predictor=${useLlm ? llm.modelName() : "code-heuristic(mock-equivalent)"}`);

  const { sessions } = generatePersonaEvents(persona, 42);
  const split = Math.max(1, Math.floor(sessions.length * 0.8));
  const train = sessions.slice(0, split);
  const holdout = sessions.slice(split);

  const storage = createStorage(":memory:");
  const engine = createEngine({ storage, llm });
  for (const s of train) {
    for (const ev of s.events) await engine.processEvent(ev);
  }

  const userId = `sim-${persona.id}`;
  const profile = engine.getProfile(userId);
  const now = storage.lastEventTs(userId)!;
  const ledger = new Map<string, string>();
  for (const it of storage.listKnowledgeItems(userId)) {
    ledger.set(it.item, effectiveState(it, now));
  }
  console.log(
    `trained on ${train.length} sessions, holdout ${holdout.length}, vocab_estimate=${profile.reading_state.vocab_estimate}, ledger=${ledger.size} items (prompt=${PROMPT_VERSIONS.predict})`,
  );

  const variants = [
    { name: "with-knowledge", useLedger: true },
    { name: "profile-only", useLedger: false },
  ];
  const summary: Record<string, { f1: number; ll: number }> = {};

  for (const v of variants) {
    let f1Sum = 0;
    let llSum = 0;
    for (const session of holdout) {
      const start = session.events.find((e) => e.type === "session_start");
      if (!start || start.type !== "session_start" || !start.material.text) continue;
      const candidates = [...new Set(start.material.text.toLowerCase().match(/word\d{4}/g) ?? [])];
      const actual = new Set(
        session.events.filter((e) => e.type === "word_lookup").map((e) => e.lemma),
      );
      const predicted = await predict(llm, useLlm, {
        vocabEstimate: profile.reading_state.vocab_estimate,
        candidates,
        ledger: v.useLedger ? ledger : new Map(),
      });
      const { f1 } = prf1(predicted, actual);
      f1Sum += f1;
      llSum += logLoss(candidates, actual, (w) =>
        lookupScore(w, profile.reading_state.vocab_estimate, v.useLedger ? (ledger.get(w) ?? null) : null),
      );
    }
    summary[v.name] = {
      f1: Math.round((f1Sum / holdout.length) * 1000) / 1000,
      ll: Math.round((llSum / holdout.length) * 1000) / 1000,
    };
    console.log(`${v.name}: F1=${summary[v.name].f1} logLoss=${summary[v.name].ll}`);
  }

  if (summary["with-knowledge"].f1 < summary["profile-only"].f1) {
    console.error("FAIL: with-knowledge variant should beat profile-only (分层建模未体现价值)");
    process.exit(1);
  }
  console.log("sim:eval OK — with-knowledge >= profile-only（分层状态对预测有增益）");
}

if (process.argv[1] && process.argv[1].endsWith("evaluate.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
