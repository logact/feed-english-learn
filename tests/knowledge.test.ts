import { describe, it, expect } from "vitest";
import {
  createFromLookup,
  createFromKnown,
  transition,
  effectiveState,
  isLegalTransition,
  MASTER_EXPOSURES,
  FADING_DAYS,
} from "../lib/engine/knowledge";
import type { KnowledgeItem } from "../contracts/knowledge";

const T0 = "2026-01-01T10:00:00.000Z";
const plusDays = (ts: string, d: number) =>
  new Date(new Date(ts).getTime() + d * 86400000).toISOString();

function lookupAt(lemma: string, ts: string, session = "s1") {
  return createFromLookup(lemma, "word", { kind: "lookup", sessionId: session, ts });
}

describe("knowledge state machine", () => {
  it("首次查词 → new", () => {
    const { item, changed } = lookupAt("apple", T0);
    expect(item.state).toBe("new");
    expect(item.lookup_count).toBe(1);
    expect(changed).toEqual({ from: null, to: "new" });
  });

  it("new → supported：短期内再次查询", () => {
    const { item } = lookupAt("apple", T0);
    const r = transition(item, { kind: "lookup", sessionId: "s1", ts: plusDays(T0, 1) }, plusDays(T0, 1));
    expect(r.item.state).toBe("supported");
    expect(r.item.lookup_count).toBe(2);
    expect(r.changed).toEqual({ from: "new", to: "supported" });
  });

  it("supported → familiar：后续 session 出现且未查", () => {
    let { item } = lookupAt("apple", T0, "s1");
    item = transition(item, { kind: "lookup", sessionId: "s1", ts: T0 }, T0).item;
    const r = transition(
      item,
      { kind: "exposure", sessionId: "s2", ts: plusDays(T0, 1), sentence: "an apple a day." },
      plusDays(T0, 1),
    );
    expect(r.item.state).toBe("familiar");
    expect(r.item.exposure_count).toBe(1);
    expect(r.item.sample_contexts[0]).toContain("apple");
  });

  it("同 session 查过又出现：不算无查询曝光（不晋级）", () => {
    const { item } = lookupAt("apple", T0, "s1");
    const r = transition(item, { kind: "exposure", sessionId: "s1", ts: T0 }, T0);
    expect(r.item.state).toBe("new");
    expect(r.item.exposure_count).toBe(0);
  });

  it("new → familiar：只查过一次，后续 session 未查即出现", () => {
    const { item } = lookupAt("apple", T0, "s1");
    const r = transition(item, { kind: "exposure", sessionId: "s2", ts: plusDays(T0, 1) }, plusDays(T0, 1));
    expect(r.item.state).toBe("familiar");
  });

  it(`familiar → mastered：累计 ${MASTER_EXPOSURES} 次无查询曝光`, () => {
    let { item } = lookupAt("apple", T0, "s1");
    item = transition(item, { kind: "exposure", sessionId: "s2", ts: plusDays(T0, 1) }, plusDays(T0, 1)).item;
    expect(item.state).toBe("familiar");
    item = transition(item, { kind: "exposure", sessionId: "s3", ts: plusDays(T0, 2) }, plusDays(T0, 2)).item;
    expect(item.state).toBe("familiar");
    const r = transition(item, { kind: "exposure", sessionId: "s4", ts: plusDays(T0, 3) }, plusDays(T0, 3));
    expect(r.item.state).toBe("mastered");
    expect(r.changed).toEqual({ from: "familiar", to: "mastered" });
  });

  it("word_known：任意状态 → mastered；首次标记直接建 mastered 条目", () => {
    const { item } = lookupAt("apple", T0);
    const r = transition(item, { kind: "known", sessionId: "s1", ts: T0 }, T0);
    expect(r.item.state).toBe("mastered");

    const direct = createFromKnown("pear", "word", { kind: "known", sessionId: "s1", ts: T0 });
    expect(direct.item.state).toBe("mastered");
  });

  it("回退：familiar/mastered 又查词 → supported", () => {
    let { item } = lookupAt("apple", T0, "s1");
    item = transition(item, { kind: "exposure", sessionId: "s2", ts: plusDays(T0, 1) }, plusDays(T0, 1)).item;
    const back = transition(item, { kind: "lookup", sessionId: "s3", ts: plusDays(T0, 2) }, plusDays(T0, 2));
    expect(back.item.state).toBe("supported");
    expect(back.changed).toEqual({ from: "familiar", to: "supported" });

    const mastered: KnowledgeItem = { ...back.item, state: "mastered", exposure_count: 10 };
    const back2 = transition(mastered, { kind: "lookup", sessionId: "s4", ts: plusDays(T0, 3) }, plusDays(T0, 3));
    expect(back2.item.state).toBe("supported");
  });

  it("惰性 fading：familiar 超过 T 天未出现 → effectiveState 为 fading（不落库）", () => {
    let { item } = lookupAt("apple", T0, "s1");
    item = transition(item, { kind: "exposure", sessionId: "s2", ts: plusDays(T0, 1) }, plusDays(T0, 1)).item;
    const within = plusDays(T0, 1 + FADING_DAYS.familiar! - 1);
    expect(effectiveState(item, within)).toBe("familiar");
    const beyond = plusDays(T0, 1 + FADING_DAYS.familiar! + 1);
    expect(effectiveState(item, beyond)).toBe("fading");
    expect(item.state).toBe("familiar"); // 落库状态不变
  });

  it("mastered 的遗忘窗口比 familiar 长", () => {
    const mastered: KnowledgeItem = {
      ...lookupAt("apple", T0).item,
      state: "mastered",
      exposure_count: 10,
    };
    const d = FADING_DAYS.familiar! + 5;
    expect(effectiveState(mastered, plusDays(T0, d))).toBe("mastered");
    expect(effectiveState(mastered, plusDays(T0, FADING_DAYS.mastered! + 1))).toBe("fading");
  });

  it("fading 复活：重新出现且未查 → familiar；若又查 → supported", () => {
    let { item } = lookupAt("apple", T0, "s1");
    item = transition(item, { kind: "exposure", sessionId: "s2", ts: plusDays(T0, 1) }, plusDays(T0, 1)).item;
    const later = plusDays(T0, 40); // 超过 familiar 的 T
    const revive = transition(item, { kind: "exposure", sessionId: "s3", ts: later }, later);
    expect(revive.item.state).toBe("familiar");
    expect(revive.changed).toEqual({ from: "fading", to: "familiar" });

    const lookupAgain = transition(item, { kind: "lookup", sessionId: "s3", ts: later }, later);
    expect(lookupAgain.item.state).toBe("supported");
    expect(lookupAgain.changed).toEqual({ from: "fading", to: "supported" });
  });

  it("LLM 回流合法迁移白名单", () => {
    expect(isLegalTransition("new", "supported")).toBe(true);
    expect(isLegalTransition("new", "familiar")).toBe(true);
    expect(isLegalTransition("supported", "familiar")).toBe(true);
    expect(isLegalTransition("familiar", "supported")).toBe(true);
    expect(isLegalTransition("fading", "familiar")).toBe(true);
    // 不允许的跃迁
    expect(isLegalTransition("new", "mastered")).toBe(false);
    expect(isLegalTransition("familiar", "mastered")).toBe(false);
    expect(isLegalTransition("mastered", "new")).toBe(false);
  });
});
