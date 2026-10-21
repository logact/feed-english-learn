// 回放引擎：把画像事件流喂给引擎，收集每个 session 后的 profile 快照。
// CLI: `pnpm sim:personas` —— 跑全部 5 个画像并输出四层指标中的第 2 层（估计质量）。
//
// 注意：使用 MockLLMClient（无 LLM_API_KEY）时，断言放宽为「流程跑通 + 指标输出」。
// 真实 LLM 下的阈值断言见 runPersonas() 中的 REAL_LLM_THRESHOLDS：
//   beginner: vocab 收敛到 1500±500 且 band 正确（A2）
//   oscillator: band 变动次数 <= 2（滞回防震荡；尺度 2 结构性不可能动 band）
import { createEngine, type Engine } from "../lib/engine/engine";
import { createStorage, type Storage } from "../lib/engine/storage";
import { createLLMClient, MockLLMClient, type LLMClient } from "../lib/engine/llm";
import { effectiveState } from "../lib/engine/knowledge";
import { bandOf } from "./lexicon";
import { PERSONAS, type Persona } from "./personas";
import { generatePersonaEvents, type GeneratedSession } from "./generator";
import { computePersonaMetrics, formatMetrics, type PersonaMetrics } from "./metrics";

export interface PersonaRunResult {
  persona: Persona;
  engine: Engine;
  storage: Storage;
  sessions: GeneratedSession[];
  metrics: PersonaMetrics;
}

export async function runPersona(
  persona: Persona,
  llm: LLMClient,
  seed = 42,
): Promise<PersonaRunResult> {
  const storage = createStorage(":memory:");
  const engine = createEngine({ storage, llm });
  const { sessions } = generatePersonaEvents(persona, seed);

  for (const session of sessions) {
    for (const ev of session.events) {
      await engine.processEvent(ev);
    }
  }

  const userId = `sim-${persona.id}`;
  const profile = engine.getProfile(userId);
  const snapshots = storage.listSnapshots(userId);
  const now = storage.lastEventTs(userId)!;
  const counts: Record<string, number> = {};
  for (const it of storage.listKnowledgeItems(userId)) {
    const s = effectiveState(it, now);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const events = storage.listEvents(userId);
  const metrics = computePersonaMetrics(persona, profile, snapshots, events, counts);
  return { persona, engine, storage, sessions, metrics };
}

/** 真实 LLM 下的验收阈值（Mock 下只打印不断言） */
export function assertRealLlmThresholds(results: PersonaRunResult[]): string[] {
  const failures: string[] = [];
  for (const r of results) {
    const { persona, metrics } = r;
    if (persona.id === "beginner" || persona.id === "advanced") {
      if (metrics.vocabConvergenceError > 500 / persona.trueVocab) {
        failures.push(
          `${persona.id}: vocab error ${(metrics.vocabConvergenceError * 100).toFixed(1)}% exceeds threshold`,
        );
      }
      if (metrics.finalBand !== bandOf(persona.trueVocab)) {
        failures.push(`${persona.id}: band ${metrics.finalBand} != truth ${bandOf(persona.trueVocab)}`);
      }
    }
    if (persona.id === "oscillator" && metrics.bandChanges > 2) {
      failures.push(`oscillator: band changed ${metrics.bandChanges} times (>2, 滞回失效)`);
    }
  }
  return failures;
}

async function main() {
  const llm = createLLMClient();
  const isMock = llm instanceof MockLLMClient;
  console.log(`LLM client: ${llm.modelName()}${isMock ? " (阈值断言放宽为流程跑通)" : ""}\n`);

  const results: PersonaRunResult[] = [];
  for (const persona of PERSONAS) {
    const r = await runPersona(persona, llm);
    results.push(r);
    console.log(formatMetrics(r.metrics));
    console.log();
  }

  // 结构性断言（任何 client 都必须满足）：
  // 尺度 2 不允许动 band —— band 变动只能发生在尺度 3，即每 K=5 个 session 一次
  const failures: string[] = [];
  for (const r of results) {
    if (r.metrics.snapshots === 0) failures.push(`${r.persona.id}: no snapshots produced`);
    const maxBandChanges = Math.ceil(r.persona.sessions / 5);
    if (r.metrics.bandChanges > maxBandChanges) {
      failures.push(
        `${r.persona.id}: bandChanges=${r.metrics.bandChanges} > ${maxBandChanges}（尺度2 泄漏）`,
      );
    }
  }

  if (!isMock) {
    failures.push(...assertRealLlmThresholds(results));
  } else {
    console.log(
      "NOTE: MockLLMClient 启发式不估计真实词汇量，vocab 收敛阈值仅在设置 LLM_API_KEY 后断言。",
    );
  }

  if (failures.length > 0) {
    console.error("\nFAILURES:");
    for (const f of failures) console.error(" - " + f);
    process.exit(1);
  }
  console.log("sim:personas OK");
}

if (process.argv[1] && process.argv[1].endsWith("runner.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
