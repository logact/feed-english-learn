import { describe, it, expect } from "vitest";
import {
  clampInt,
  applySessionUpdate,
  applyStageReview,
  stageGate,
  CLAMP_LENGTH_PCT,
  CLAMP_WPM_PCT,
} from "../lib/engine/profiler";
import { defaultProfile, ProfileSessionUpdateSchema } from "../contracts/profile";

const NOW = "2026-01-02T10:00:00.000Z";

function makeUpdate(overrides: {
  comfortable_length_words?: number;
  max_length_words?: number;
  reading_speed_wpm?: number;
}) {
  return ProfileSessionUpdateSchema.parse({
    reading_state: { ...overrides, evidence: "test evidence" },
    interests: [],
    notes: "test",
    knowledge_annotations: [],
  });
}

describe("clamp（尺度 2 有界调整，代码强制）", () => {
  it("clampInt 基本行为", () => {
    expect(clampInt(1000, 500, 0.2)).toBe(600); // 封顶 +20%
    expect(clampInt(10, 500, 0.2)).toBe(400); // 封底 -20%
    expect(clampInt(520, 500, 0.2)).toBe(520); // 界内不动
  });

  it("极端 digest 下 comfortable_length 单次最多 ±20%", () => {
    const profile = defaultProfile("u", NOW); // len=300
    const up = applySessionUpdate(profile, makeUpdate({ comfortable_length_words: 5000 }), NOW);
    expect(up.profile.reading_state.comfortable_length_words).toBe(
      Math.round(300 * (1 + CLAMP_LENGTH_PCT)),
    );
    const down = applySessionUpdate(profile, makeUpdate({ comfortable_length_words: 1 }), NOW);
    expect(down.profile.reading_state.comfortable_length_words).toBe(
      Math.floor(300 * (1 - CLAMP_LENGTH_PCT)),
    );
  });

  it("reading_speed_wpm 单次最多 ±10%", () => {
    const profile = defaultProfile("u", NOW); // wpm=120
    const up = applySessionUpdate(profile, makeUpdate({ reading_speed_wpm: 500 }), NOW);
    expect(up.profile.reading_state.reading_speed_wpm).toBe(Math.round(120 * (1 + CLAMP_WPM_PCT)));
  });

  it("尺度 2 schema 结构性不含 band/vocab_estimate：额外字段被拒绝", () => {
    const withBand = {
      reading_state: { evidence: "x", band: "C2", vocab_estimate: 99999 },
      interests: [],
      notes: "",
      knowledge_annotations: [],
    };
    const parsed = ProfileSessionUpdateSchema.safeParse(withBand);
    // strict 对象拒绝未知键；即使宽松解析，applySessionUpdate 也读不到 band
    if (parsed.success) {
      expect("band" in parsed.data.reading_state).toBe(false);
    } else {
      expect(parsed.success).toBe(false);
    }
    // applySessionUpdate 永远不动 band/vocab
    const profile = defaultProfile("u", NOW);
    const r = applySessionUpdate(profile, makeUpdate({}), NOW);
    expect(r.profile.reading_state.band).toBe(profile.reading_state.band);
    expect(r.profile.reading_state.vocab_estimate).toBe(profile.reading_state.vocab_estimate);
  });

  it("sessions_since_review 递增，version 递增", () => {
    const profile = defaultProfile("u", NOW);
    const r = applySessionUpdate(profile, makeUpdate({}), NOW);
    expect(r.profile.reading_state.sessions_since_review).toBe(1);
    expect(r.profile.version).toBe(1);
  });
});

describe("尺度 3：滞回 gate 与幅度约束", () => {
  const dg = (density: number) => `lookup_density=${density.toFixed(2)}%\nother=1`;

  it("最近 3 个 session 密度同向才放行", () => {
    expect(stageGate([dg(0.5), dg(0.8), dg(0.2)])).toBe("up");
    expect(stageGate([dg(6), dg(8), dg(5.5)])).toBe("down");
    expect(stageGate([dg(0.5), dg(8), dg(0.2)])).toBe("hold");
    expect(stageGate([dg(0.5), dg(0.8)])).toBe("hold"); // 不足 3 个
  });

  it("gate=hold 时 LLM 想调整也不生效", () => {
    const profile = defaultProfile("u", NOW);
    const r = applyStageReview(
      profile,
      { adjust: true, band: "B2", vocab_estimate: 9999, evidence: "x" },
      "hold",
      NOW,
    );
    expect(r.profile.reading_state.band).toBe("A2");
    expect(r.profile.reading_state.vocab_estimate).toBe(2000);
    expect(r.profile.reading_state.sessions_since_review).toBe(0);
  });

  it("gate=up：band 最多一级，vocab 最多 +20% 且不允许下降", () => {
    const profile = defaultProfile("u", NOW); // A2, 2000
    const r = applyStageReview(
      profile,
      { adjust: true, band: "C2", vocab_estimate: 4000, evidence: "x" },
      "up",
      NOW,
    );
    expect(r.profile.reading_state.band).toBe("B1"); // 跳两级被压到一级
    expect(r.profile.reading_state.vocab_estimate).toBe(2400);

    const downAttempt = applyStageReview(
      profile,
      { adjust: true, band: "A1", vocab_estimate: 500, evidence: "x" },
      "up",
      NOW,
    );
    expect(downAttempt.profile.reading_state.band).toBe("A2"); // 方向不符被压制
    expect(downAttempt.profile.reading_state.vocab_estimate).toBe(2000);
  });

  it("gate=down：band 降一级，vocab 最多 -20% 且不允许上升", () => {
    const profile = defaultProfile("u", NOW);
    const r = applyStageReview(
      profile,
      { adjust: true, band: "A1", vocab_estimate: 100, evidence: "x" },
      "down",
      NOW,
    );
    expect(r.profile.reading_state.band).toBe("A1");
    expect(r.profile.reading_state.vocab_estimate).toBe(1600);
  });

  it("adjust=false：只重置计数与证据", () => {
    const profile = defaultProfile("u", NOW);
    profile.reading_state.sessions_since_review = 5;
    const r = applyStageReview(profile, { adjust: false, evidence: "mixed" }, "up", NOW);
    expect(r.profile.reading_state.band).toBe("A2");
    expect(r.profile.reading_state.sessions_since_review).toBe(0);
  });
});
