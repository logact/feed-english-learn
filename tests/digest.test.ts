import { describe, it, expect } from "vitest";
import { buildSessionDigest, buildStageDigest, parseLookupDensity } from "../lib/engine/digest";
import type { ReadingEvent } from "../contracts/events";

const base = { user_id: "u", session_id: "s1" };

const events: ReadingEvent[] = [
  {
    ...base,
    type: "session_start",
    ts: "2026-01-01T10:00:00.000Z",
    material: {
      material_id: "m1",
      topics: ["technology"],
      difficulty: "B1",
      length_words: 400,
      summary: "about tech",
    },
  },
  { ...base, type: "word_lookup", ts: "2026-01-01T10:01:00.000Z", lemma: "apple", item_type: "word", sentence: "an apple." },
  { ...base, type: "word_lookup", ts: "2026-01-01T10:02:00.000Z", lemma: "apple", item_type: "word", sentence: "an apple." },
  { ...base, type: "word_lookup", ts: "2026-01-01T10:03:00.000Z", lemma: "pear", item_type: "word", sentence: "a pear." },
  {
    ...base,
    type: "material_completed",
    ts: "2026-01-01T10:05:00.000Z",
    material_id: "m1",
    completion_rate: 1,
    duration_ms: 240000, // 400 words / 4 min = 100 wpm
    words_read: 400,
  },
  { ...base, type: "session_end", ts: "2026-01-01T10:05:30.000Z" },
];

describe("digest", () => {
  it("聚合查词数、密度、wpm、材料元数据", () => {
    const d = buildSessionDigest({
      events,
      material: events[0].type === "session_start" ? events[0].material : null,
      knowledgeChanges: [],
    });
    expect(d).toContain("lookups=3");
    expect(d).toContain("lookup_density=0.75%"); // 3/400
    expect(d).toContain("reading_speed_wpm=100");
    expect(d).toContain("completion_rate=100%");
    expect(d).toContain("topics=[technology]");
    expect(d).toContain("apple×2");
    expect(d).toContain("abandoned=false");
  });

  it("知识点变化分组", () => {
    const d = buildSessionDigest({
      events,
      material: null,
      knowledgeChanges: [
        { user_id: "u", session_id: "s1", item: "a", from_state: "supported", to_state: "familiar", trigger: "exposure", note: null, ts: "" },
        { user_id: "u", session_id: "s1", item: "b", from_state: "supported", to_state: "familiar", trigger: "exposure", note: null, ts: "" },
        { user_id: "u", session_id: "s1", item: "c", from_state: null, to_state: "new", trigger: "lookup", note: null, ts: "" },
      ],
    });
    expect(d).toContain("2 supported→familiar (a,b)");
    expect(d).toContain("1 null→new (c)");
  });

  it("parseLookupDensity 往返", () => {
    expect(parseLookupDensity("xx lookup_density=4.20% yy")).toBeCloseTo(4.2);
    expect(parseLookupDensity("none")).toBeNull();
  });

  it("stage digest 包含汇总与逐 session digest", () => {
    const d = buildStageDigest(["s-a lookup_density=1.00%", "s-b lookup_density=2.00%"], {
      total: 10,
      byState: { new: 4, familiar: 6 },
      masteredLastK: 2,
      fadingNow: 1,
    }, 5);
    expect(d).toContain("total=10");
    expect(d).toContain("fading_now=1");
    expect(d).toContain("session_digest[0]");
  });
});
