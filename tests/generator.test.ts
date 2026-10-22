import { describe, it, expect, beforeEach } from "vitest";
import { createStorage, type Storage } from "../lib/engine/storage";
import {
  MockLLMClient,
  OpenAICompatibleClient,
  type LLMClient,
  type LLMRequest,
  type LLMResult,
} from "../lib/engine/llm";
import { createEngine, type Engine } from "../lib/engine/engine";
import { GeneratorError } from "../lib/engine/generator";
import { checkDraft, classifyWord, tokenize, type CheckContext } from "../lib/engine/textcheck";
import type { TargetSpec } from "../contracts/target-spec";
import type { GeneratorTurn } from "../contracts/generator";
import { wordAt } from "../sim/lexicon";

// ---------------------------------------------------------------------------
// 纯函数：textcheck
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<TargetSpec> = {}): TargetSpec {
  return {
    user_id: "u1",
    band: "A2",
    length_words: [100, 200],
    topics: ["tech"],
    review_items: [],
    new_item_budget: 3,
    avoid_items: [],
    notes: "",
    generated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    spec: makeSpec(),
    targetLookupRate: [0.02, 0.05],
    ledger: new Map(),
    vocabEstimate: 2000,
    ...overrides,
  };
}

function knownText(n: number, startRank = 500): string {
  return Array.from({ length: n }, (_, i) => wordAt(startRank + (i % 50) * 10)).join(" ") + ".";
}

describe("textcheck", () => {
  it("tokenize：小写化并按既有正则切词", () => {
    expect(tokenize("Hello, World! It's fine.")).toEqual(["hello", "world", "it's", "fine"]);
  });

  it("classifyWord：账本状态优先，其次词频 rank，无法判定归 untracked", () => {
    const ledger = new Map([
      ["a", "familiar" as const],
      ["b", "fading" as const],
      ["c", "new" as const],
    ]);
    expect(classifyWord("a", ledger, 2000)).toBe("known_ledger");
    expect(classifyWord("b", ledger, 2000)).toBe("review_ledger");
    expect(classifyWord("c", ledger, 2000)).toBe("new_ledger");
    expect(classifyWord(wordAt(1000), ledger, 2000)).toBe("known_rank");
    expect(classifyWord(wordAt(2100), ledger, 2000)).toBe("stretch");
    expect(classifyWord("zzqqx", ledger, 2000)).toBe("untracked");
  });

  it("checkDraft：全已知词文本通过", () => {
    const report = checkDraft(knownText(150), makeCtx());
    expect(report.pass).toBe(true);
    expect(report.predicted_lookup_rate).toBe(0);
  });

  it("checkDraft：篇幅越界失败", () => {
    const report = checkDraft(knownText(50), makeCtx());
    expect(report.pass).toBe(false);
    expect(report.length_ok).toBe(false);
    expect(report.failures.some((f) => f.includes("length"))).toBe(true);
  });

  it("checkDraft：硬生词率超 target hi 失败（即使 budget 够）", () => {
    const text = `${knownText(90)} ${Array.from({ length: 10 }, (_, i) => wordAt(2100 + i)).join(" ")}`;
    const report = checkDraft(text, makeCtx({ spec: makeSpec({ new_item_budget: 20 }) }));
    expect(report.coverage_ok).toBe(false);
    expect(report.pass).toBe(false);
  });

  it("checkDraft：不同新词数超 budget 失败（即使覆盖率够）", () => {
    const text = `${knownText(195)} ${Array.from({ length: 5 }, (_, i) => wordAt(2100 + i)).join(" ")}`;
    const report = checkDraft(text, makeCtx());
    expect(report.budget_ok).toBe(false);
    expect(report.new_items_used).toBe(5);
    expect(report.pass).toBe(false);
  });

  it("checkDraft：avoid 词出现即违规", () => {
    const report = checkDraft(
      `${knownText(100)} apple`,
      makeCtx({ spec: makeSpec({ avoid_items: ["apple"], new_item_budget: 5 }) }),
    );
    expect(report.avoid_violations).toEqual(["apple"]);
    expect(report.pass).toBe(false);
  });

  it("checkDraft：review_items 出现率不足 80% 失败；review 词不计入硬生词率", () => {
    const ledger = new Map([
      ["old1", "supported" as const],
      ["old2", "fading" as const],
      ["old3", "supported" as const],
    ]);
    const spec = makeSpec({
      review_items: [
        { item: "old1", state: "supported", sample_context: null },
        { item: "old2", state: "fading", sample_context: null },
        { item: "old3", state: "supported", sample_context: null },
      ],
    });
    const missing = checkDraft(`${knownText(100)} old1 old2`, makeCtx({ spec, ledger }));
    expect(missing.review_ok).toBe(false);
    expect(missing.failures.some((f) => f.includes("old3"))).toBe(true);
    const full = checkDraft(`${knownText(100)} old1 old2 old3`, makeCtx({ spec, ledger }));
    expect(full.review_ok).toBe(true);
    expect(full.predicted_lookup_rate).toBe(0);
    expect(full.review_occurrences).toBe(3);
    expect(full.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loop 驱动：集成（真实 storage + Mock / 脚本化 LLM）
// ---------------------------------------------------------------------------

/** 按回合顺序返回预置 GeneratorTurn 的脚本化客户端（超过末回合后重复末回合） */
class ScriptedLLM implements LLMClient {
  private i = 0;
  constructor(private turns: GeneratorTurn[]) {}
  modelName(): string {
    return "scripted";
  }
  async complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    const turn = this.turns[Math.min(this.i, this.turns.length - 1)];
    this.i += 1;
    const raw = JSON.stringify(turn);
    return { data: req.schema.parse(JSON.parse(raw)) as T, raw, attempts: 1, usage: null, model: "scripted" };
  }
}

const NOW = "2026-01-01T10:00:00.000Z";

function upsertKnowledge(userId: string, storage: Storage, item: string, state: string, lookupCount: number) {
  storage.upsertKnowledgeItem(
    userId,
    {
      item,
      item_type: "word",
      state: state as "new" | "supported" | "familiar" | "mastered" | "fading",
      lookup_count: lookupCount,
      exposure_count: 0,
      first_seen: "2026-01-01T00:00:00.000Z",
      last_seen: "2026-01-01T09:00:00.000Z",
      last_lookup_ts: "2026-01-01T09:00:00.000Z",
      last_lookup_session: "s1",
      next_review: null,
      note: null,
      sample_contexts: [`sample with ${item}.`],
    },
    "2026-01-01T09:00:00.000Z",
  );
}

describe("generator loop", () => {
  const userId = "u1";
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage(":memory:");
  });

  it("Mock 生成器收敛：pass、落库、journal 记录", async () => {
    const engine: Engine = createEngine({ storage, llm: new MockLLMClient() });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-gen-1" });
    expect(result.report.pass).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.turns).toBeLessThanOrEqual(8);
    // 默认画像 comfortable=300：篇幅应落在 [300,500]
    expect(result.report.length_words).toBeGreaterThanOrEqual(300);
    expect(result.report.length_words).toBeLessThanOrEqual(500);

    expect(storage.getMaterial("m-gen-1")?.text).toBe(result.material.text);
    const journal = storage.listJournal(userId).filter((j) => j.scale === "generate");
    expect(journal.length).toBe(1);
    expect(journal[0].promptVersion).toBe("generate_material@v1");
  });

  it("check_words 超限时截取前 50 个并继续生成", async () => {
    const good: GeneratorTurn = {
      action: "submit",
      text: knownText(300),
      summary: "good",
      topics: ["tech"],
      new_items: [],
    };
    const words = Array.from({ length: 53 }, (_, i) => `word${1000 + i}`);
    let calls = 0;
    const llm = new OpenAICompatibleClient({
      model: "test",
      transport: async ({ messages }) => {
        calls += 1;
        if (calls === 2) {
          const toolResult = messages.find((m) => m.content.startsWith("TOOL_RESULT check_words:"));
          expect(toolResult?.content).toContain("word1049=");
          expect(toolResult?.content).not.toContain("word1050=");
        }
        return {
          content:
            calls === 1
              ? JSON.stringify({ action: "check_words", words })
              : JSON.stringify(good),
          usage: null,
        };
      },
    });
    const engine: Engine = createEngine({ storage, llm });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-long-check" });

    expect(result.turns).toBe(2);
    expect(result.material.text).toBe(good.text);
    expect(calls).toBe(2);
  });

  it("supported 旧词进入 review_items 并被 Mock 织入", async () => {
    upsertKnowledge(userId, storage, "word1500", "supported", 2);
    const engine: Engine = createEngine({ storage, llm: new MockLLMClient() });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-gen-2" });
    expect(result.report.pass).toBe(true);
    expect(result.report.review_coverage).toEqual([{ item: "word1500", present: true }]);
  });

  it("拒绝路径：坏草稿被打回后继续，好草稿通过", async () => {
    upsertKnowledge(userId, storage, "word2500", "new", 3); // → avoid_items
    const bad: GeneratorTurn = {
      action: "submit",
      text: `${knownText(300)} word2500`,
      summary: "bad",
      topics: ["tech"],
      new_items: [],
    };
    const good: GeneratorTurn = {
      action: "submit",
      text: knownText(300),
      summary: "good",
      topics: ["tech"],
      new_items: [],
    };
    const engine: Engine = createEngine({ storage, llm: new ScriptedLLM([bad, good]) });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-rej" });
    expect(result.turns).toBe(2);
    expect(result.report.pass).toBe(true);
    expect(result.material.text).toBe(good.text);
  });

  it("兜底路径：永不通过时返回 best-effort 并带 warnings", async () => {
    upsertKnowledge(userId, storage, "word2500", "new", 3); // → avoid_items
    const bad: GeneratorTurn = {
      action: "submit",
      text: `${knownText(300)} word2500`,
      summary: "bad",
      topics: ["tech"],
      new_items: [],
    };
    const engine: Engine = createEngine({ storage, llm: new ScriptedLLM([bad]) });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-fb", maxTurns: 4 });
    expect(result.turns).toBe(4);
    expect(result.report.pass).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(storage.getMaterial("m-fb")).not.toBeNull(); // best-effort 仍落库
  });

  it("check_draft 的合格草稿无需 submit 即被验收", async () => {
    const checkOnly: GeneratorTurn = { action: "check_draft", text: knownText(300) };
    const engine: Engine = createEngine({ storage, llm: new ScriptedLLM([checkOnly]) });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-cd" });
    expect(result.turns).toBe(1);
    expect(result.report.pass).toBe(true);
    expect(storage.getMaterial("m-cd")?.text).toBe(knownText(300));
  });

  it("只有 check_draft 且无合格草稿：兜底返回 best-effort 而非抛错", async () => {
    upsertKnowledge(userId, storage, "word2500", "new", 3); // → avoid_items
    const badDraft: GeneratorTurn = { action: "check_draft", text: `${knownText(300)} word2500` };
    const engine: Engine = createEngine({ storage, llm: new ScriptedLLM([badDraft]) });
    const result = await engine.generateMaterial(userId, { now: NOW, materialId: "m-cdb", maxTurns: 3 });
    expect(result.turns).toBe(3);
    expect(result.report.pass).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(storage.getMaterial("m-cdb")).not.toBeNull();
  });

  it("全程无任何草稿：抛 GeneratorError 且 journal 记录失败轨迹", async () => {
    const onlyChecks: GeneratorTurn = { action: "check_words", words: ["word2100"] };
    const engine: Engine = createEngine({ storage, llm: new ScriptedLLM([onlyChecks]) });
    await expect(
      engine.generateMaterial(userId, { now: NOW, maxTurns: 3 }),
    ).rejects.toThrow(GeneratorError);
    const journal = storage.listJournal(userId).filter((j) => j.scale === "generate");
    expect(journal.length).toBe(1);
    expect(journal[0].delta.error).toEqual({ from: null, to: "no_draft_seen" });
  });
});
