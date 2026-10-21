import { describe, it, expect } from "vitest";
import { createStorage, type Storage } from "../lib/engine/storage";
import { MockLLMClient, type LLMClient } from "../lib/engine/llm";
import { runStageReview, STAGE_REVIEW_INTERVAL } from "../lib/engine/profiler";
import { createEngine } from "../lib/engine/engine";
import type { ReadingEvent } from "../contracts/events";

let storage: Storage;
let llm: LLMClient;

function makeSession(userId: string, sessionId: string, opts: { lookupDensity?: number; words?: number } = {}) {
  const words = opts.words ?? 400;
  const lookups = Math.round(((opts.lookupDensity ?? 2) / 100) * words);
  const events: ReadingEvent[] = [
    {
      type: "session_start",
      user_id: userId,
      session_id: sessionId,
      ts: "2026-01-01T10:00:00.000Z",
      material: {
        material_id: `m-${sessionId}`,
        topics: ["tech"],
        difficulty: "A2",
        length_words: words,
        summary: "s",
        text: "apple pear banana ".repeat(Math.ceil(words / 3)).slice(0, 4000),
      },
    },
  ];
  for (let i = 0; i < lookups; i++) {
    events.push({
      type: "word_lookup",
      user_id: userId,
      session_id: sessionId,
      ts: "2026-01-01T10:01:00.000Z",
      lemma: `fruit${i}`,
      item_type: "word",
      sentence: `the fruit${i} is red.`,
    });
  }
  events.push(
    {
      type: "material_completed",
      user_id: userId,
      session_id: sessionId,
      ts: "2026-01-01T10:10:00.000Z",
      material_id: `m-${sessionId}`,
      completion_rate: 1,
      duration_ms: 200000,
      words_read: words,
    },
    { type: "session_end", user_id: userId, session_id: sessionId, ts: "2026-01-01T10:11:00.000Z" },
  );
  return events;
}

describe("profiler 编排（MockLLMClient + 内存库）", () => {
  it("session_end 触发尺度 2：profile 更新、快照、journal 落库", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    for (const ev of makeSession("u1", "s1")) await engine.processEvent(ev);

    const profile = storage.getProfile("u1")!;
    expect(profile.version).toBe(1);
    expect(profile.reading_state.sessions_since_review).toBe(1);
    expect(profile.interests[0]?.topic).toBe("tech");

    const journal = storage.listJournal("u1");
    expect(journal.length).toBe(1);
    expect(journal[0].scale).toBe("session");
    expect(journal[0].rawResponse).toBeTruthy();
    expect(journal[0].inputSummary).toContain("lookup_density=");

    const snapshots = storage.listSnapshots("u1");
    expect(snapshots.length).toBe(1);
  });

  it("K 个 session 后触发尺度 3（密度混合 → gate=hold → band 不动、计数归零）", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    for (let i = 0; i < STAGE_REVIEW_INTERVAL; i++) {
      for (const ev of makeSession("u2", `s${i}`, { lookupDensity: i % 2 === 0 ? 0.5 : 6 })) {
        await engine.processEvent(ev);
      }
    }
    const profile = storage.getProfile("u2")!;
    expect(profile.reading_state.band).toBe("A2"); // 混合密度 → hold
    expect(profile.reading_state.sessions_since_review).toBe(0);
    const stages = storage.listJournal("u2").filter((j) => j.scale === "stage_review");
    expect(stages.length).toBe(1);
    expect(stages[0].model).toBe("none"); // hold 不调 LLM
  });

  it("K 个 session 连续高密度 → gate=down → band 降一级", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    for (let i = 0; i < STAGE_REVIEW_INTERVAL; i++) {
      for (const ev of makeSession("u3", `s${i}`, { lookupDensity: 7 })) {
        await engine.processEvent(ev);
      }
    }
    const profile = storage.getProfile("u3")!;
    expect(profile.reading_state.band).toBe("A1");
    expect(profile.reading_state.vocab_estimate).toBeLessThan(2000);
  });

  it("knowledge_annotations 校验：不在本 session 的词被拒绝", async () => {
    storage = createStorage(":memory:");
    // 伪造一个返回 annotation 的 client
    const annotating: LLMClient = {
      modelName: () => "test",
      complete: async <T,>() => ({
        data: {
          reading_state: { evidence: "e" },
          interests: [],
          notes: "",
          knowledge_annotations: [
            { item: "fruit0", suggest_state: "familiar", note: "ok" }, // 本 session 查过，但 new→familiar 合法
            { item: "ghost", suggest_state: "familiar", note: "not in session" },
            { item: "fruit1", suggest_state: "mastered", note: "illegal jump" },
          ],
        } as T,
        raw: "{}",
        attempts: 1,
        usage: null,
        model: "test",
      }),
    };
    const engine = createEngine({ storage, llm: annotating });
    for (const ev of makeSession("u4", "s1", { lookupDensity: 2 })) await engine.processEvent(ev);

    const fruit0 = storage.getKnowledgeItem("u4", "fruit0");
    expect(fruit0?.state).toBe("familiar"); // 合法注解已应用
    expect(storage.getKnowledgeItem("u4", "ghost")).toBeNull();
    const fruit1 = storage.getKnowledgeItem("u4", "fruit1");
    expect(fruit1?.state).toBe("new"); // 非法跃迁被拒绝

    const changes = storage.listKnowledgeChanges("u4", "fruit0");
    expect(changes.some((c) => c.trigger === "llm_annotation")).toBe(true);

    const journal = storage.listJournal("u4")[0];
    const ann = (journal.delta as { knowledge_annotations: { to: { applied: number; rejected: unknown[] } } })
      .knowledge_annotations.to;
    expect(ann.applied).toBe(1);
    expect(ann.rejected.length).toBe(2);
  });

  it("prompt 组装：user 消息包含 digest 与完整 profile JSON", async () => {
    storage = createStorage(":memory:");
    let seen = "";
    const spy: LLMClient = {
      modelName: () => "spy",
      complete: async <T,>(req: { messages: { content: string }[] }) => {
        seen = req.messages.map((m) => m.content).join("\n");
        return {
          data: {
            reading_state: { evidence: "e" },
            interests: [],
            notes: "",
            knowledge_annotations: [],
          } as T,
          raw: "{}",
          attempts: 1,
          usage: null,
          model: "spy",
        };
      },
    };
    const engine = createEngine({ storage, llm: spy });
    for (const ev of makeSession("u5", "s1")) await engine.processEvent(ev);
    expect(seen).toContain("SESSION_DIGEST:");
    expect(seen).toContain("CURRENT_PROFILE_JSON:");
    expect(seen).toContain('"user_id": "u5"');
  });

  it("runStageReview 直接调用：密度不足 3 个 session → hold", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const r = await runStageReview(storage, llm, "nobody");
    expect(r.gate).toBe("hold");
  });
});
