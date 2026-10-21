import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  OpenAICompatibleClient,
  MockLLMClient,
  LLMValidationError,
  createLLMClient,
} from "../lib/engine/llm";
import { ProfileSessionUpdateSchema, StageReviewOutputSchema } from "../contracts/profile";

const SimpleSchema = z.object({ ok: z.boolean(), n: z.number().int() });

describe("OpenAICompatibleClient（注入假 transport）", () => {
  it("正常返回：解析 + token 统计", async () => {
    const client = new OpenAICompatibleClient({
      model: "test-model",
      transport: async () => ({
        content: JSON.stringify({ ok: true, n: 3 }),
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
    });
    const r = await client.complete({
      schemaName: "Simple",
      schema: SimpleSchema,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.data).toEqual({ ok: true, n: 3 });
    expect(r.attempts).toBe(1);
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(r.model).toBe("test-model");
  });

  it("Zod 校验失败重试一次后成功", async () => {
    let calls = 0;
    const client = new OpenAICompatibleClient({
      model: "m",
      transport: async ({ messages }) => {
        calls++;
        if (calls === 1) return { content: JSON.stringify({ ok: "yes" }), usage: null };
        // 第二次应收到错误反馈
        expect(messages.some((m) => m.content.includes("failed validation"))).toBe(true);
        return { content: JSON.stringify({ ok: true, n: 1 }), usage: null };
      },
    });
    const r = await client.complete({ schemaName: "S", schema: SimpleSchema, messages: [] });
    expect(r.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("两次都失败 → LLMValidationError（带原始响应）", async () => {
    const client = new OpenAICompatibleClient({
      model: "m",
      transport: async () => ({ content: "not json at all", usage: null }),
    });
    await expect(
      client.complete({ schemaName: "S", schema: SimpleSchema, messages: [] }),
    ).rejects.toThrow(LLMValidationError);
  });

  it("代码围栏包裹的 JSON 也能解析", async () => {
    const client = new OpenAICompatibleClient({
      model: "m",
      transport: async () => ({ content: "```json\n{\"ok\":true,\"n\":2}\n```", usage: null }),
    });
    const r = await client.complete({ schemaName: "S", schema: SimpleSchema, messages: [] });
    expect(r.data.n).toBe(2);
  });
});

describe("MockLLMClient：确定性启发式输出合法", () => {
  const mock = new MockLLMClient();

  it("ProfileSessionUpdate：高密度 → 缩短篇幅", async () => {
    const r = await mock.complete({
      schemaName: "ProfileSessionUpdate",
      schema: ProfileSessionUpdateSchema,
      messages: [
        {
          role: "user",
          content:
            "SESSION_DIGEST:\nlookup_density=6.50% completion_rate=60 length_words=400 topics=[tech]\n" +
            'CURRENT_PROFILE_JSON:\n{"reading_state":{"comfortable_length_words":300,"reading_speed_wpm":120},"interests":[]}',
        },
      ],
    });
    expect(r.data.reading_state.comfortable_length_words).toBeLessThan(300);
    expect(r.data.interests[0]?.topic).toBe("tech");
    expect(r.data.reading_state.evidence).toContain("6.5");
  });

  it("StageReviewOutput：连续低密度 → 升级", async () => {
    const r = await mock.complete({
      schemaName: "StageReviewOutput",
      schema: StageReviewOutputSchema,
      messages: [
        {
          role: "user",
          content:
            "lookup_density=0.50%\nlookup_density=0.80%\nlookup_density=0.30%\n" +
            'CURRENT_PROFILE_JSON:\n{"reading_state":{"band":"A2","vocab_estimate":2000}}',
        },
      ],
    });
    expect(r.data.adjust).toBe(true);
    expect(r.data.band).toBe("B1");
    expect(r.data.vocab_estimate).toBe(2300);
  });

  it("StageReviewOutput：密度混合 → hold", async () => {
    const r = await mock.complete({
      schemaName: "StageReviewOutput",
      schema: StageReviewOutputSchema,
      messages: [
        {
          role: "user",
          content: "lookup_density=0.50%\nlookup_density=8.00%\nlookup_density=0.30%",
        },
      ],
    });
    expect(r.data.adjust).toBe(false);
  });
});

describe("createLLMClient 选择", () => {
  it("无 LLM_API_KEY → Mock；有 → OpenAI 兼容", () => {
    const saved = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    expect(createLLMClient()).toBeInstanceOf(MockLLMClient);
    process.env.LLM_API_KEY = "sk-test";
    expect(createLLMClient()).toBeInstanceOf(OpenAICompatibleClient);
    if (saved === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = saved;
  });
});
