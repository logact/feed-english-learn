// LLM 抽象：引擎只依赖 LLMClient 接口，构造时注入。
// - OpenAICompatibleClient：openai SDK，LLM_BASE_URL / LLM_API_KEY /LLM_MODEL 环境变量配置，temperature=0，
//   Zod 校验失败重试一次（把校验错误反馈给模型），token 统计。
// - MockLLMClient：确定性启发式实现，根据 digest 中的数字机械生成合法输出，
//   供单元测试与无 API key 时跑通 sim 全流程。
import OpenAI from "openai";
import { z, type ZodType } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Band } from "../../contracts/profile";
import { BANDS } from "../../contracts/profile";
import { wordAt } from "../../sim/lexicon";

export interface LLMMessage {
  role: "system" | "user";
  content: string;
}

export interface LLMRequest<T> {
  /** 逻辑契约名，Mock 客户端按它分派启发式行为，journal 也记录 */
  schemaName: string;
  schema: ZodType<T>;
  messages: LLMMessage[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LLMResult<T> {
  data: T;
  raw: string;
  attempts: number;
  usage: TokenUsage | null;
  model: string;
}

export interface LLMClient {
  complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>>;
  modelName(): string;
}

export class LLMValidationError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "LLMValidationError";
  }
}

// ---------------------------------------------------------------------------
// OpenAI 兼容实现
// ---------------------------------------------------------------------------

/** 底层传输：可注入假实现用于测试重试逻辑 */
export type CompletionTransport = (opts: {
  model: string;
  messages: LLMMessage[];
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}) => Promise<{ content: string; usage: TokenUsage | null }>;

export interface OpenAIClientOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  transport?: CompletionTransport;
}

export type ResponseFormatMode = "json_schema" | "json_object" | "none";

// 部分 OpenAI 兼容端点不支持 json_schema（甚至 json_object）response_format，
// 400 时沿链降级，并记住当前端点可用的格式。
const FORMAT_FALLBACK: ResponseFormatMode[] = ["json_schema", "json_object", "none"];

export class OpenAICompatibleClient implements LLMClient {
  private client: OpenAI | null;
  private model: string;
  private transport: CompletionTransport | null;
  private formatMode: ResponseFormatMode;

  constructor(opts: OpenAIClientOptions = {}) {
    this.model = opts.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
    this.transport = opts.transport ?? null;
    const envMode = process.env.LLM_RESPONSE_FORMAT as ResponseFormatMode | undefined;
    this.formatMode = FORMAT_FALLBACK.includes(envMode as ResponseFormatMode)
      ? (envMode as ResponseFormatMode)
      : "json_schema";
    this.client = this.transport
      ? null
      : new OpenAI({
          baseURL: opts.baseURL ?? process.env.LLM_BASE_URL,
          apiKey: opts.apiKey ?? process.env.LLM_API_KEY,
        });
  }

  modelName(): string {
    return this.model;
  }

  private async defaultTransport(opts: Parameters<CompletionTransport>[0]) {
    if (!this.client) throw new Error("OpenAI client not initialized");
    for (let i = FORMAT_FALLBACK.indexOf(this.formatMode); i < FORMAT_FALLBACK.length; i++) {
      const mode = FORMAT_FALLBACK[i];
      try {
        const resp = await this.client.chat.completions.create({
          model: opts.model,
          temperature: 0,
          messages: opts.messages,
          ...(mode === "json_schema"
            ? {
                response_format: {
                  type: "json_schema" as const,
                  json_schema: { name: opts.schemaName, schema: opts.jsonSchema, strict: false },
                },
              }
            : mode === "json_object"
              ? { response_format: { type: "json_object" as const } }
              : {}),
        });
        this.formatMode = mode;
        const content = resp.choices[0]?.message?.content ?? "";
        return {
          content,
          usage: resp.usage
            ? { promptTokens: resp.usage.prompt_tokens, completionTokens: resp.usage.completion_tokens }
            : null,
        };
      } catch (e) {
        const status = (e as { status?: number }).status;
        const msg = e instanceof Error ? e.message : String(e);
        const formatUnsupported = status === 400 && /response_format/i.test(msg);
        if (!formatUnsupported || mode === "none") throw e;
        this.formatMode = FORMAT_FALLBACK[i + 1];
      }
    }
    throw new Error("unreachable");
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    const transport = this.transport ?? this.defaultTransport.bind(this);
    const jsonSchema = zodToJson(req.schema);
    const messages = [...req.messages];
    let lastRaw = "";
    let lastError = "";
    let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
    let sawUsage = false;

    // 首次 + 校验失败重试一次
    for (let attempt = 1; attempt <= 2; attempt++) {
      const resp = await transport({
        model: this.model,
        messages,
        jsonSchema,
        schemaName: req.schemaName,
      });
      lastRaw = resp.content;
      if (resp.usage) {
        sawUsage = true;
        totalUsage = {
          promptTokens: totalUsage.promptTokens + resp.usage.promptTokens,
          completionTokens: totalUsage.completionTokens + resp.usage.completionTokens,
        };
      }
      try {
        const parsed = req.schema.parse(JSON.parse(stripCodeFence(resp.content)));
        return {
          data: parsed,
          raw: resp.content,
          attempts: attempt,
          usage: sawUsage ? totalUsage : null,
          model: this.model,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        messages.push(
          { role: "user", content: resp.content },
          {
            role: "user",
            content:
              `Your previous response failed validation: ${lastError}\n` +
              "Return a corrected JSON object that conforms to the schema.",
          },
        );
      }
    }
    throw new LLMValidationError(
      `LLM output failed validation after 2 attempts: ${lastError}`,
      lastRaw,
      2,
    );
  }
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s.trim();
}

function zodToJson(schema: ZodType<unknown>): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock 实现：确定性启发式
// ---------------------------------------------------------------------------

function extractProfileJson(messages: LLMMessage[]): Record<string, unknown> | null {
  for (const m of messages) {
    const idx = m.content.indexOf("CURRENT_PROFILE_JSON:");
    if (idx >= 0) {
      const start = m.content.indexOf("{", idx);
      const end = m.content.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(m.content.slice(start, end + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function allText(messages: LLMMessage[]): string {
  return messages.map((m) => m.content).join("\n");
}

/** 只取 user 消息中指定区块的文本，避免解析到 system prompt 里的示例数字 */
function section(messages: LLMMessage[], start: string, end?: string): string {
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const i = userText.indexOf(start);
  if (i < 0) return userText;
  const rest = userText.slice(i + start.length);
  if (!end) return rest;
  const j = rest.indexOf(end);
  return j < 0 ? rest : rest.slice(0, j);
}

function parseDensities(text: string): number[] {
  // 匹配 lookup_density=4.20%
  return [...text.matchAll(/lookup_density=([\d.]+)%/g)].map((m) => parseFloat(m[1]));
}

function parseNumber(text: string, key: string): number | null {
  const m = text.match(new RegExp(`${key}=([\\d.]+)`));
  return m ? parseFloat(m[1]) : null;
}

function parseTopics(text: string): string[] {
  const m = text.match(/topics=\[([^\]]*)\]/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface MockReadingState {
  band?: string;
  vocab_estimate?: number;
  comfortable_length_words?: number;
  max_length_words?: number;
  reading_speed_wpm?: number;
}

function mockSessionUpdate(messages: LLMMessage[]) {
  const digest = section(messages, "SESSION_DIGEST:", "CURRENT_PROFILE_JSON:");
  const profile = extractProfileJson(messages);
  const rs = (profile?.reading_state ?? {}) as MockReadingState;
  const density = parseDensities(digest)[0] ?? 0;
  const completion = parseNumber(digest, "completion_rate") ?? 100;
  const observedWpm = parseNumber(digest, "reading_speed_wpm");
  const materialLen = parseNumber(digest, "length_words");
  const topics = parseTopics(digest);

  const curLen = rs.comfortable_length_words ?? 300;
  const curWpm = rs.reading_speed_wpm ?? 120;

  // 机械规则：查词密度超目标 → 缩短并减速；远低于目标 → 加长
  let newLen = curLen;
  if (density > 5) newLen = Math.round(curLen * 0.85);
  else if (density < 1 && completion >= 95) newLen = Math.round(curLen * 1.15);
  let newWpm = curWpm;
  if (observedWpm && observedWpm > 0) newWpm = Math.round(curWpm * 0.5 + observedWpm * 0.5);

  // 兴趣：材料主题权重 +0.15（封顶 1），未出现主题 *0.9
  const prev = Array.isArray(profile?.interests)
    ? (profile.interests as { topic: string; weight: number; note: string }[])
    : [];
  const merged = new Map<string, { topic: string; weight: number; note: string }>();
  for (const it of prev) merged.set(it.topic, { ...it, weight: it.weight * 0.9 });
  for (const t of topics) {
    const cur = merged.get(t);
    merged.set(t, {
      topic: t,
      weight: Math.min(1, (cur?.weight ?? 0) + 0.15),
      note: cur?.note ?? "seen in session material",
    });
  }
  const interests = [...merged.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((it) => ({ ...it, weight: Math.round(it.weight * 1000) / 1000 }));

  const abandoned = /abandoned=true/.test(digest);
  const evidence =
    `mock heuristic: lookup_density=${density}% completion=${completion}%` +
    (materialLen ? ` material_length=${materialLen}` : "") +
    (abandoned ? " abandoned=true" : "") +
    ` → length ${curLen}→${newLen}, wpm ${curWpm}→${newWpm}`;

  return {
    reading_state: {
      confidence: 0.5,
      comfortable_length_words: newLen,
      max_length_words: Math.round(newLen * 1.5),
      reading_speed_wpm: newWpm,
      evidence,
    },
    interests,
    notes: `mock notes: density=${density}% completion=${completion}% topics=${topics.join("/")}`,
    knowledge_annotations: [],
  };
}

function mockStageReview(messages: LLMMessage[]) {
  const stageDigest = section(messages, "STAGE_DIGEST:", "CURRENT_PROFILE_JSON:");
  const profile = extractProfileJson(messages);
  const rs = (profile?.reading_state ?? {}) as MockReadingState;
  const densities = parseDensities(stageDigest).slice(-3);
  const curBand = (rs.band as Band) ?? "A2";
  const curVocab = rs.vocab_estimate ?? 2000;
  const bandIdx = BANDS.indexOf(curBand);

  const allLow = densities.length >= 3 && densities.every((d) => d < 1);
  const allHigh = densities.length >= 3 && densities.every((d) => d > 5);

  if (allLow && bandIdx < BANDS.length - 1) {
    return {
      adjust: true,
      band: BANDS[bandIdx + 1],
      vocab_estimate: Math.round(curVocab * 1.15),
      confidence: 0.6,
      evidence: `mock heuristic: last densities [${densities.join(",")}] all <1% → upgrade one band`,
    };
  }
  if (allHigh && bandIdx > 0) {
    return {
      adjust: true,
      band: BANDS[bandIdx - 1],
      vocab_estimate: Math.round(curVocab * 0.85),
      confidence: 0.6,
      evidence: `mock heuristic: last densities [${densities.join(",")}] all >5% → downgrade one band`,
    };
  }
  return {
    adjust: false,
    confidence: 0.4,
    evidence: `mock heuristic: last densities [${densities.join(",")}] mixed → hold`,
  };
}

function mockLookupPrediction(messages: LLMMessage[]) {
  const text = allText(messages);
  const vocab = parseNumber(text, "vocab_estimate") ?? 2000;
  const candMatch = text.match(/candidate_words=\[([^\]]*)\]/);
  const candidates = candMatch
    ? candMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const fadingMatch = text.match(/fading_items=\[([^\]]*)\]/);
  const fading = fadingMatch
    ? fadingMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // 合成词表词形为 word0001：rank > vocab_estimate 的预测为会查；fading 词也预测会查
  const likely = candidates.filter((w) => {
    const m = w.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) > vocab : false;
  });
  for (const f of fading) if (!likely.includes(f)) likely.push(f);
  return {
    likely_lookups: likely,
    reasoning: `mock heuristic: words with rank>${vocab} plus ${fading.length} fading items`,
  };
}

// 生成器 mock：第 1 轮 check_words 候选拉伸词，之后 submit 按构造即可通过体检的
// 合成草稿（已知区 filler + 全部 review 词 + budget 个 stretch 词，均匀散布全文，
// 篇幅对齐舒适长度）。blocked = avoid ∪ LEDGER_HARD；stretch 额外排除 review 词
// （supported/fading 词是旧词重现，抢占 stretch 名额会导致材料不含真新词而停滞）。
function mockGeneratorTurn(messages: LLMMessage[]) {
  const specText = section(messages, "TARGET_SPEC_JSON:", "\n\nVOCAB_ESTIMATE");
  const spec = JSON.parse(specText) as {
    length_words: [number, number];
    new_item_budget: number;
    review_items?: { item: string }[];
    avoid_items?: string[];
    topics?: string[];
  };
  const vocab = parseNumber(allText(messages), "VOCAB_ESTIMATE") ?? 2000;
  const budget = Math.max(0, spec.new_item_budget ?? 1);
  const minLen = spec.length_words?.[0] ?? 300;
  const reviewItems = (spec.review_items ?? []).map((r) => r.item);
  const reviewSet = new Set(reviewItems);
  const hardMatch = allText(messages).match(/LEDGER_HARD=\[([^\]]*)\]/);
  const blocked = new Set([
    ...(spec.avoid_items ?? []),
    ...(hardMatch ? hardMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : []),
  ]);

  const stretch: string[] = [];
  for (let i = 0; stretch.length < budget && i < budget * 4 + 40; i++) {
    const w = wordAt(vocab + 100 + i * 25);
    if (!blocked.has(w) && !reviewSet.has(w) && !stretch.includes(w)) stretch.push(w);
  }

  if (!allText(messages).includes("ASSISTANT_TURN:")) {
    return { action: "check_words", words: stretch.slice(0, Math.max(1, Math.min(3, stretch.length))) };
  }

  const fillerCount = Math.max(0, minLen - stretch.length - reviewItems.length);
  const step = Math.max(1, Math.floor((vocab * 0.6) / 40));
  const palette: string[] = [];
  for (let k = 0; k < 40; k++) {
    const w = wordAt(vocab * 0.3 + k * step);
    if (!blocked.has(w) && !palette.includes(w)) palette.push(w);
  }
  if (palette.length === 0) palette.push(wordAt(1));
  const filler = Array.from({ length: fillerCount }, (_, i) => palette[i % palette.length]);

  // 均匀散布：review / stretch 词穿插进 filler，避免集中文末（放弃阅读时读不到）
  const words = [...filler];
  reviewItems.forEach((w, i) => {
    words.splice(Math.floor(((i + 0.5) * words.length) / Math.max(1, reviewItems.length)), 0, w);
  });
  stretch.forEach((w, i) => {
    words.splice(Math.floor(((i + 0.5) * words.length) / Math.max(1, stretch.length)), 0, w);
  });
  const sentences: string[] = [];
  for (let i = 0; i < words.length; i += 12) {
    sentences.push(words.slice(i, i + 12).join(" ") + ".");
  }
  const topics = (spec.topics ?? []).slice(0, 2);
  return {
    action: "submit",
    text: sentences.join(" "),
    summary: `mock material on ${topics.join("/") || "general"}`,
    topics: topics.length > 0 ? topics : ["general"],
    new_items: stretch,
  };
}

export class MockLLMClient implements LLMClient {
  modelName(): string {
    return "mock-heuristic";
  }

  async complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    let data: unknown;
    switch (req.schemaName) {
      case "ProfileSessionUpdate":
        data = mockSessionUpdate(req.messages);
        break;
      case "StageReviewOutput":
        data = mockStageReview(req.messages);
        break;
      case "LookupPrediction":
        data = mockLookupPrediction(req.messages);
        break;
      case "GeneratorTurn":
        data = mockGeneratorTurn(req.messages);
        break;
      default:
        throw new Error(`MockLLMClient: no heuristic for schema "${req.schemaName}"`);
    }
    const raw = JSON.stringify(data);
    return {
      data: req.schema.parse(JSON.parse(raw)),
      raw,
      attempts: 1,
      usage: null,
      model: this.modelName(),
    };
  }
}

// ---------------------------------------------------------------------------
// 默认选择：有 LLM_API_KEY 用真实客户端，否则 Mock
// ---------------------------------------------------------------------------

let envLoaded = false;

/** tsx 脚本不经过 Next 的 env 加载，这里补读 .env.local */
export function loadEnvLocal(): void {
  if (envLoaded) return;
  envLoaded = true;
  for (const name of [".env.local", ".env"]) {
    const p = join(/* turbopackIgnore: true */ process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

export function createLLMClient(): LLMClient {
  loadEnvLocal();
  if (process.env.LLM_API_KEY) return new OpenAICompatibleClient();
  return new MockLLMClient();
}
