import { describe, it, expect } from "vitest";
import { rankOfEn, rankCandidates, defaultRankOf } from "../lib/engine/lexicon";
import { classifyWord, checkDraft, type CheckContext } from "../lib/engine/textcheck";
import type { TargetSpec } from "../contracts/target-spec";

describe("lexicon（真实词频表）", () => {
  it("高频词 rank 小、低频词 rank 大，顺序合理", () => {
    expect(rankOfEn("the")).toBe(1);
    const apple = rankOfEn("apple");
    const algorithm = rankOfEn("algorithm");
    expect(apple).not.toBeNull();
    expect(algorithm).not.toBeNull();
    expect(rankOfEn("the")!).toBeLessThan(apple!);
    expect(apple!).toBeLessThan(algorithm!);
  });

  it("词形还原候选：cats→cat、cities→city、running→run", () => {
    expect(rankCandidates("cats")).toContain("cat");
    expect(rankCandidates("cities")).toContain("city");
    expect(rankCandidates("running")).toContain("run");
  });

  it("变形词取词族最小 rank：cats 与 cat 同 rank", () => {
    expect(rankOfEn("cats")).toBe(rankOfEn("cat"));
  });

  it("表外词返回 null", () => {
    expect(rankOfEn("zzzqqqx")).toBeNull();
  });

  it("defaultRankOf：sim 合成词优先，真实英文词走词频表", () => {
    expect(defaultRankOf("word2100")).toBe(2100);
    expect(defaultRankOf("apple")).toBe(rankOfEn("apple"));
    expect(defaultRankOf("zzzqqqx")).toBeNull();
  });
});

describe("textcheck × 真实词表", () => {
  function enCtx(overrides: Partial<CheckContext> = {}): CheckContext {
    const spec: TargetSpec = {
      user_id: "u1",
      band: "A2",
      length_words: [100, 200],
      topics: [],
      review_items: [],
      new_item_budget: 2,
      avoid_items: [],
      notes: "",
      generated_at: "2026-01-01T00:00:00.000Z",
    };
    return {
      spec,
      targetLookupRate: [0.02, 0.05],
      ledger: new Map(),
      vocabEstimate: 2000,
      ...overrides,
    };
  }

  it("classifyWord：真实英文按 rank 分界", () => {
    const ledger = new Map<string, never>();
    expect(classifyWord("apple", ledger, 2000)).toBe("known_rank"); // 1747 < 1960
    expect(classifyWord("algorithm", ledger, 2000)).toBe("stretch"); // 6805
    expect(classifyWord("ubiquitous", ledger, 2000)).toBe("untracked"); // 表外
  });

  it("全基础词的真实英文草稿可通过验收", () => {
    const text = "the cat and the dog are happy ".repeat(20); // 160 tokens，rank 均 < 1960
    const report = checkDraft(text, enCtx());
    expect(report.pass).toBe(true);
    expect(report.predicted_lookup_rate).toBe(0);
  });

  it("不同难词数超 budget 即拒绝（覆盖率仍在界内）", () => {
    const easy = "the cat and the dog are happy ".repeat(20);
    const report = checkDraft(`${easy} algorithm commence ubiquitous`, enCtx());
    // 3 个不同难词 > budget=2；3 硬 token / 163 ≈ 1.8% ≤ 5%，覆盖率通过——隔离出 budget 失败
    expect(report.new_items_used).toBe(3);
    expect(report.coverage_ok).toBe(true);
    expect(report.budget_ok).toBe(false);
    expect(report.pass).toBe(false);
  });

  it("账本状态压过词频：高频词被用户查过后算硬词", () => {
    const ledger = new Map([["apple", "new" as const]]);
    expect(classifyWord("apple", ledger, 2000)).toBe("new_ledger");
    const easy = "the cat and the dog are happy ".repeat(20);
    const report = checkDraft(`${easy}apple`, enCtx({ ledger }));
    expect(report.new_items).toEqual([]); // new_ledger 计入率但不占新词预算
    expect(report.predicted_lookup_rate).toBeGreaterThan(0);
  });
});
