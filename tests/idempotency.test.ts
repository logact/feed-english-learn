import { describe, it, expect } from "vitest";
import { createStorage } from "../lib/engine/storage";
import { MockLLMClient, type LLMClient, type LLMRequest, type LLMResult } from "../lib/engine/llm";
import { createEngine } from "../lib/engine/engine";
import type { ReadingEvent } from "../contracts/events";

const USER = "u1";
const SESSION = "s1";

const material = {
  material_id: "m1",
  topics: ["daily"],
  difficulty: "A2",
  length_words: 3,
  summary: "s",
  text: "The cat sat.",
};

const sessionStart: ReadingEvent = {
  user_id: USER,
  session_id: SESSION,
  ts: "2026-01-01T10:00:00.000Z",
  event_id: "ev-start",
  type: "session_start",
  material,
};

const lookup: ReadingEvent = {
  user_id: USER,
  session_id: SESSION,
  ts: "2026-01-01T10:01:00.000Z",
  event_id: "ev-lookup",
  type: "word_lookup",
  lemma: "cat",
  item_type: "word",
  sentence: "The cat sat.",
};

const sessionEnd: ReadingEvent = {
  user_id: USER,
  session_id: SESSION,
  ts: "2026-01-01T10:05:00.000Z",
  event_id: "ev-end",
  type: "session_end",
};

function setup() {
  const storage = createStorage(":memory:");
  const engine = createEngine({ storage, llm: new MockLLMClient() });
  return { storage, engine };
}

describe("processEvent 幂等（issue #9）", () => {
  it("同一 event_id 的 word_lookup 重发：事件/账本/变更只记一次", async () => {
    const { storage, engine } = setup();
    await engine.processEvent(sessionStart);
    const r1 = await engine.processEvent(lookup);
    const r2 = await engine.processEvent(lookup);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);

    expect(storage.listEvents(USER).filter((e) => e.type === "word_lookup")).toHaveLength(1);
    const item = storage.getKnowledgeItem(USER, "cat");
    expect(item?.lookup_count).toBe(1);
    expect(storage.listKnowledgeChanges(USER, "cat")).toHaveLength(1);
  });

  it("session_end 重发（带 event_id）：profile/journal 不重复应用", async () => {
    const { storage, engine } = setup();
    await engine.processEvent(sessionStart);
    await engine.processEvent(lookup);
    const r1 = await engine.processEvent(sessionEnd);
    const afterFirst = {
      version: engine.getProfile(USER).version,
      sessionsSinceReview: engine.getProfile(USER).reading_state.sessions_since_review,
      journal: storage.listJournal(USER).length,
      events: storage.listEvents(USER).length,
    };
    const r2 = await engine.processEvent(sessionEnd);

    expect(r1.sessionUpdated).toBe(true);
    expect(r2.duplicate).toBe(true);
    expect(r2.sessionUpdated).toBe(false);
    expect(engine.getProfile(USER).version).toBe(afterFirst.version);
    expect(engine.getProfile(USER).reading_state.sessions_since_review).toBe(
      afterFirst.sessionsSinceReview,
    );
    expect(storage.listJournal(USER)).toHaveLength(afterFirst.journal);
    expect(storage.listEvents(USER)).toHaveLength(afterFirst.events);
  });

  it("session_end 重发（无 event_id 的旧客户端）：按 (user, session) 天然去重", async () => {
    const { storage, engine } = setup();
    const start = { ...sessionStart, event_id: undefined };
    const end = { ...sessionEnd, event_id: undefined };
    await engine.processEvent(start);
    await engine.processEvent(end);
    await engine.processEvent(end);

    expect(storage.listEvents(USER).filter((e) => e.type === "session_end")).toHaveLength(1);
    expect(storage.listJournal(USER).filter((j) => j.scale === "session")).toHaveLength(1);
  });

  it("session_end 处理中 LLM 抛错：整体回滚，修复后重试可完整应用", async () => {
    const storage = createStorage(":memory:");
    const flaky: LLMClient = {
      modelName: () => "flaky",
      complete: <T,>(req: LLMRequest<T>): Promise<LLMResult<T>> => {
        if (req.schemaName === "ProfileSessionUpdate") {
          return Promise.reject(new Error("LLM validation failed"));
        }
        return Promise.reject(new Error(`unexpected ${req.schemaName}`));
      },
    };
    const engine = createEngine({ storage, llm: flaky });
    await engine.processEvent(sessionStart);
    await engine.processEvent(lookup);

    await expect(engine.processEvent(sessionEnd)).rejects.toThrow("LLM validation failed");
    // 整体回滚：事件行、profile、journal、曝光均无残留
    expect(storage.listEvents(USER).some((e) => e.type === "session_end")).toBe(false);
    expect(storage.getProfile(USER)).toBeNull();
    expect(storage.listJournal(USER)).toHaveLength(0);
    const cat = storage.getKnowledgeItem(USER, "cat");
    expect(cat?.exposure_count ?? 0).toBe(0);

    // 客户端带同一 event_id 重试：LLM 恢复后完整应用一次
    const recovered = createEngine({ storage, llm: new MockLLMClient() });
    const r = await recovered.processEvent(sessionEnd);
    expect(r.duplicate).toBe(false);
    expect(r.sessionUpdated).toBe(true);
    expect(storage.listEvents(USER).filter((e) => e.type === "session_end")).toHaveLength(1);
    expect(storage.listJournal(USER).filter((j) => j.scale === "session")).toHaveLength(1);
  });

  it("processEvents 批内单事件失败：其余事件照常落库，逐事件状态可见", async () => {
    const { storage, engine } = setup();
    const result = await engine.processEvents([
      sessionStart,
      lookup,
      { bogus: true }, // 校验失败
      sessionEnd,
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.processed).toBe(3);
    expect(result.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
    expect(result.sessionUpdates).toBe(1);
    expect(storage.listEvents(USER)).toHaveLength(3);

    // 整批重放（客户端重试）：全部去重，无二次副作用
    const again = await engine.processEvents([sessionStart, lookup, sessionEnd]);
    expect(again.results.map((r) => r.status)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(again.sessionUpdates).toBe(0);
    expect(storage.listEvents(USER)).toHaveLength(3);
    expect(storage.listJournal(USER).filter((j) => j.scale === "session")).toHaveLength(1);
  });
});
