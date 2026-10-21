// 闭环演示（无 LLM key，MockLLMClient）：造事件 → engine 处理 → 打印 profile 与 target-spec。
// CLI: `pnpm demo`
import { rmSync } from "node:fs";
import { createEngine } from "../lib/engine/engine";
import { createStorage } from "../lib/engine/storage";
import { MockLLMClient } from "../lib/engine/llm";
import { personaById } from "./personas";
import { generatePersonaEvents } from "./generator";

const DB_PATH = "data/demo.db";

async function main() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB_PATH + suffix, { force: true });

  const storage = createStorage(DB_PATH);
  const engine = createEngine({ storage, llm: new MockLLMClient() });

  const persona = personaById("beginner");
  const { sessions } = generatePersonaEvents(persona, 7);
  const userId = `sim-${persona.id}`;
  console.log(`demo: persona=${persona.id} sessions=${sessions.length} db=${DB_PATH}\n`);

  for (const s of sessions) {
    for (const ev of s.events) await engine.processEvent(ev);
    const p = engine.getProfile(userId);
    console.log(
      `after ${s.sessionId}: band=${p.reading_state.band} vocab=${p.reading_state.vocab_estimate} ` +
        `len=${p.reading_state.comfortable_length_words} wpm=${p.reading_state.reading_speed_wpm} ` +
        `sinceReview=${p.reading_state.sessions_since_review}`,
    );
  }

  console.log("\n=== final profile ===");
  console.log(JSON.stringify(engine.getProfile(userId), null, 2));
  console.log("\n=== target-spec（给材料生成引擎） ===");
  console.log(JSON.stringify(engine.getTargetSpec(userId), null, 2));

  const journal = storage.listJournal(userId);
  console.log(`\njournal entries: ${journal.length}（含尺度2/尺度3 全部 LLM 交互与 delta）`);
  console.log(`调试页：启动 next dev 后访问 /debug/${userId}（ENGINE_DB_PATH=${DB_PATH}）`);
  storage.close();
  console.log("\ndemo OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
