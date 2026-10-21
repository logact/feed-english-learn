// 调优网格：对比不同旋钮组合下的仿真指标（响应速度 vs 平滑 / 震荡）。
// CLI: `pnpm sim:tune`
// 真实 LLM 下建议扩大网格并对每个 cell 跑 k=3 次取分布（防过拟合：画像已注入噪声）。
import { createLLMClient, type LLMClient } from "../lib/engine/llm";
import { createEngine } from "../lib/engine/engine";
import { createStorage } from "../lib/engine/storage";
import type { Tuning } from "../lib/engine/profiler";
import { personaById } from "./personas";
import { generatePersonaEvents } from "./generator";
import { bandChangeCount, sessionLookupDensities } from "./metrics";

interface Cell {
  tuning: Tuning;
  label: string;
}

const GRID: Cell[] = [];
for (const clampLengthPct of [0.1, 0.2, 0.3]) {
  for (const stageReviewInterval of [3, 5, 8]) {
    GRID.push({
      tuning: { clampLengthPct, stageReviewInterval },
      label: `clamp=±${clampLengthPct * 100}% K=${stageReviewInterval}`,
    });
  }
}

async function main() {
  const llm: LLMClient = createLLMClient();
  console.log(`llm=${llm.modelName()} grid=${GRID.length} cells`);
  // 用进阶者（需要向上收敛）+ 震荡者（需要稳定）两个画像观察旋钮影响
  const personas = [personaById("advanced"), personaById("oscillator")];

  console.log("label | persona | finalLen | finalVocab | bandChanges | meanDensity");
  for (const cell of GRID) {
    for (const persona of personas) {
      const storage = createStorage(":memory:");
      const engine = createEngine({ storage, llm, tuning: cell.tuning });
      const { sessions } = generatePersonaEvents(persona, 42);
      for (const s of sessions) for (const ev of s.events) await engine.processEvent(ev);
      const userId = `sim-${persona.id}`;
      const profile = engine.getProfile(userId);
      const snapshots = storage.listSnapshots(userId);
      const densities = sessionLookupDensities(storage.listEvents(userId));
      const mean = densities.reduce((a, b) => a + b, 0) / Math.max(1, densities.length);
      console.log(
        `${cell.label} | ${persona.id} | ${profile.reading_state.comfortable_length_words} | ` +
          `${profile.reading_state.vocab_estimate} | ${bandChangeCount(snapshots)} | ${mean.toFixed(2)}%`,
      );
      storage.close();
    }
  }
  console.log(
    "\n解读：clamp 越大响应越快但越不平滑；K 越小阶段检查越频繁（震荡风险越高）。\n" +
      "真实 LLM 下的选择流程：本网格 → 敏感性分析 → 噪声注入防过拟合 → 影子重放后切换。",
  );
}

if (process.argv[1] && process.argv[1].endsWith("tune.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
