// 全量事件 replay 重推导 vs 当前 profile 对比，暴露记忆漂移（纠偏层）。
// CLI: `pnpm sim:replay <userId> [dbPath]`（默认 data/engine.db）
// MockLLMClient 下 replay 确定性可复现，diff 应为空；真实 LLM 下 diff 非空即漂移信号。
import { createEngine } from "../lib/engine/engine";
import { createStorage } from "../lib/engine/storage";
import { createLLMClient } from "../lib/engine/llm";

async function main() {
  const userId = process.argv[2];
  const dbPath = process.argv[3] ?? process.env.ENGINE_DB_PATH ?? "data/engine.db";
  if (!userId) {
    console.error("usage: tsx sim/replay.ts <userId> [dbPath]");
    process.exit(1);
  }
  const storage = createStorage(dbPath);
  const llm = createLLMClient();
  const engine = createEngine({ storage, llm });

  const events = storage.listEvents(userId);
  if (events.length === 0) {
    console.error(`no events for user ${userId} in ${dbPath}`);
    process.exit(1);
  }
  console.log(`replaying ${events.length} events for ${userId} (llm=${llm.modelName()})...`);
  const { replayed, current, diff } = await engine.replay(userId);
  if (diff.length === 0) {
    console.log("replay consistent: 无记忆漂移");
  } else {
    console.log(`DRIFT detected (${diff.length} fields):`);
    for (const d of diff) console.log(" - " + d);
  }
  console.log(`replayed version=${replayed.version} current version=${current.version}`);
  storage.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
