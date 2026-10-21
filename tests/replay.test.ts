import { describe, it, expect } from "vitest";
import { createStorage } from "../lib/engine/storage";
import { MockLLMClient } from "../lib/engine/llm";
import { createEngine } from "../lib/engine/engine";
import { effectiveState } from "../lib/engine/knowledge";
import { generatePersonaEvents } from "../sim/generator";
import { personaById } from "../sim/personas";

describe("replay 一致性（Mock 确定性）", () => {
  it("全量重放推导与当前 profile 完全一致", async () => {
    const storage = createStorage(":memory:");
    const engine = createEngine({ storage, llm: new MockLLMClient() });
    const persona = personaById("beginner");
    const { sessions } = generatePersonaEvents(persona, 42);
    const userId = `sim-${persona.id}`;
    for (const s of sessions.slice(0, 6)) {
      for (const ev of s.events) await engine.processEvent(ev);
    }
    const { diff, replayed, current } = await engine.replay(userId);
    expect(diff).toEqual([]);
    expect(replayed.version).toBe(current.version);
  });

  it("getTargetSpec 满足生成引擎契约：review_items / new_item_budget / avoid_items", async () => {
    const storage = createStorage(":memory:");
    const engine = createEngine({ storage, llm: new MockLLMClient() });
    const persona = personaById("forgetter");
    const { sessions } = generatePersonaEvents(persona, 42);
    const userId = `sim-${persona.id}`;
    for (const s of sessions) {
      for (const ev of s.events) await engine.processEvent(ev);
    }
    const spec = engine.getTargetSpec(userId);
    expect(spec.band).toBeTruthy();
    expect(spec.length_words[0]).toBeLessThanOrEqual(spec.length_words[1]);
    expect(spec.new_item_budget).toBeGreaterThan(0);
    expect(Array.isArray(spec.review_items)).toBe(true);
    // 遗忘者：35 天空窗后旧词应进入 fading 或 supported，成为 review_items
    expect(spec.review_items.length).toBeGreaterThan(0);
    for (const ri of spec.review_items) {
      expect(["fading", "supported"]).toContain(ri.state);
    }
  });

  it("遗忘者时序：掌握词 35 天未出现 → fading；回归后重现 → 复活", async () => {
    const storage = createStorage(":memory:");
    const engine = createEngine({ storage, llm: new MockLLMClient() });
    const persona = personaById("forgetter");
    const { sessions } = generatePersonaEvents(persona, 42);
    const userId = `sim-${persona.id}`;

    // 前 4 个 session（2026-01-01 ~ 01-04）
    for (const s of sessions.slice(0, 4)) {
      for (const ev of s.events) await engine.processEvent(ev);
    }
    const itemsBefore = storage.listKnowledgeItems(userId);
    expect(itemsBefore.length).toBeGreaterThan(0);
    // 前 4 个 session 主动标记了 mastered 词
    expect(itemsBefore.some((it) => it.state === "mastered")).toBe(true);

    // 35 天空窗结束时（回归 session 开始时刻）：mastered 词（T=30 天）应已 fading
    const returnTs = sessions[4].events[0].ts;
    const fadingAtReturn = itemsBefore.filter((it) => effectiveState(it, returnTs) === "fading");
    expect(fadingAtReturn.length).toBeGreaterThan(0);

    // 回归 session（材料大量重现旧词）
    for (const s of sessions.slice(4)) {
      for (const ev of s.events) await engine.processEvent(ev);
    }
    const changes = storage.listKnowledgeChanges(userId);
    const revivals = changes.filter((c) => c.from_state === "fading" && c.to_state === "familiar");
    expect(revivals.length).toBeGreaterThan(0);
  });
});
