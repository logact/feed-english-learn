import { describe, it, expect } from "vitest";
import { createStorage, type Storage } from "../lib/engine/storage";
import { MockLLMClient, type LLMClient } from "../lib/engine/llm";
import { createEngine } from "../lib/engine/engine";
import type { ReadingEvent } from "../contracts/events";

const base = { user_id: "u1", session_id: "s1" };

function sessionEvents(): ReadingEvent[] {
  return [
    {
      ...base,
      type: "session_start",
      ts: "2026-01-01T10:00:00.000Z",
      event_id: "ev-start",
      material: {
        material_id: "m-s1",
        topics: ["tech"],
        difficulty: "A2",
        length_words: 100,
        summary: "s",
        text: "apple pear banana",
      },
    },
    {
      ...base,
      type: "word_lookup",
      ts: "2026-01-01T10:01:00.000Z",
      event_id: "ev-lookup-1",
      lemma: "apple",
      item_type: "word",
      sentence: "apple pear banana",
    },
    {
      ...base,
      type: "session_end",
      ts: "2026-01-01T10:05:00.000Z",
      event_id: "ev-end",
    },
  ];
}

describe("事件摄入幂等去重（issue #3）", () => {
  let storage: Storage;
  let llm: LLMClient;

  it("重复投递同一批事件：事件流、知识账本、profile、journal 均只记一次", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    const events = sessionEvents();
    for (const ev of events) await engine.processEvent(ev);
    // 模拟客户端静默重试：整批原样重发
    for (const ev of events) await engine.processEvent(ev);

    expect(storage.listEvents("u1").length).toBe(events.length);
    expect(storage.getKnowledgeItem("u1", "apple")?.lookup_count).toBe(1);
    expect(storage.getProfile("u1")?.version).toBe(1);
    expect(storage.getProfile("u1")?.reading_state.sessions_since_review).toBe(1);
    expect(storage.listJournal("u1").length).toBe(1);
  });

  it("session_end 按 (user_id, session_id) 幂等,即使重发时 event_id 不同", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    const end1: ReadingEvent = {
      ...base,
      type: "session_end",
      ts: "2026-01-01T10:05:00.000Z",
      event_id: "ev-end-1",
    };
    const end2: ReadingEvent = {
      ...base,
      type: "session_end",
      ts: "2026-01-01T10:05:05.000Z",
      event_id: "ev-end-2",
    };

    expect(await engine.processEvent(end1)).toBe(true);
    expect(await engine.processEvent(end2)).toBe(false);

    expect(storage.listJournal("u1").length).toBe(1);
    expect(storage.listEvents("u1").filter((e) => e.type === "session_end").length).toBe(1);
  });

  it("不同 event_id 的同类事件不去重", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    const lookup = (eventId: string, ts: string): ReadingEvent => ({
      ...base,
      type: "word_lookup",
      ts,
      event_id: eventId,
      lemma: "apple",
      item_type: "word",
      sentence: "apple pear banana",
    });

    expect(await engine.processEvent(lookup("ev-a", "2026-01-01T10:01:00.000Z"))).toBe(true);
    expect(await engine.processEvent(lookup("ev-b", "2026-01-01T10:02:00.000Z"))).toBe(true);
    expect(storage.getKnowledgeItem("u1", "apple")?.lookup_count).toBe(2);
  });

  it("processEvents 报告重复计数", async () => {
    storage = createStorage(":memory:");
    llm = new MockLLMClient();
    const engine = createEngine({ storage, llm });
    const events = sessionEvents();

    const first = await engine.processEvents(events);
    expect(first.duplicates).toBe(0);
    expect(first.sessionUpdates).toBe(1);

    const retry = await engine.processEvents(events);
    expect(retry.duplicates).toBe(events.length);
    expect(retry.sessionUpdates).toBe(0);
  });
});
