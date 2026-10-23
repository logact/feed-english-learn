# 项目工作原理:关键逻辑与代码导览

面向想理解整个系统的读者。阅读顺序建议:§1 闭环 → §2 目录地图 → §3 设计哲学 → §4~§9 引擎内部 → §10~§12 外围层。

## 1. 产品闭环

可理解性输入(comprehensible input)自适应循环,对应 PRD 的四步:

```
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
  ① 用户档案 UserProfile        ④ 行为事件回流更新档案与词汇账本
  (band/词汇量/兴趣/速度)        (session_end → LLM 更新;
        │                       word_lookup → 状态机即时记账)
        ▼                                              │
  ② 组装 TargetSpec ──→ ③ 生成 N+1 材料 ──→ 用户阅读 ──┘
  (难度/篇幅/复习词/新词预算)   (agentic loop,代码验收)
```

一句话:**代码告诉 LLM「发生了什么」,LLM 告诉系统「这意味着什么」**。所有数字裁决(状态迁移、clamp、滞回、材料验收)都在确定性代码里;LLM 只做解读(profile 更新)和创作(写材料),且都被代码 gate。

## 2. 目录地图

| 目录 | 角色 |
|---|---|
| `contracts/` | 全部跨模块数据结构(zod schema),系统的「语言」 |
| `lib/engine/` | 引擎核心,不依赖 Next.js,可在 tsx/vitest 独立运行 |
| `lib/engine/prompts/` | LLM system prompt(带版本号,记进 journal) |
| `app/` | Next.js UI + API 薄壳,只做「HTTP ↔ engine」翻译 |
| `sim/` | 仿真:虚拟用户画像跑全流程,验证引擎质量 |
| `tests/` | vitest,重点覆盖纯函数(状态机/clamp/digest/验收) |

## 3. 设计哲学:为什么 LLM 不能直接改数字

LLM 输出不稳定,直接让它维护「用户水平」会震荡。系统的解法是**结构性约束**:

- LLM 的输出 schema 里**物理上不存在**某些字段(如 session 级更新没有 `band`);
- 存在的字段也被代码 clamp(篇幅单次 ±20%、速度 ±10%);
- 调档(band)需要行为证据**连续 3 次同向**才放行(滞回 gate),且每次最多一级;
- 每次 LLM 更新的 prompt 版本、原始响应、实际 delta 都记入 `update_journal`,可审计、可回放。

## 4. 契约层 `contracts/`

一切从 zod schema 开始,`contracts/export-json-schema.ts` 可导出 JSON Schema。

### 4.1 两层用户模型(`contracts/profile.ts` + `contracts/knowledge.ts`)

**UserProfile(慢变量,LLM 维护)**:对「未见词难度」的泛化判断 —— band、vocab_estimate、舒适篇幅、阅读速度、兴趣、自由文本 notes。解决冷启动和非词汇信号(速度、放弃)。

**KnowledgeItem(快变量,代码记账)**:每个具体词的状态。

```ts
// contracts/knowledge.ts
export const KNOWLEDGE_STATES = ["new", "supported", "familiar", "mastered", "fading"] as const;
```

为什么必须两层:查过的词有账本,但「这篇文章对用户太难」这种结论是关于**没查过的词**的泛化,无词汇可归,只能由 profile 层承载。

### 4.2 事件(`contracts/events.ts`)

UI 与引擎之间唯一的写入通道,7 种事件的判别联合:

```ts
export const ReadingEventSchema = z.discriminatedUnion("type", [
  SessionStartEventSchema,    // 带 MaterialMeta(含 text,供曝光记账)
  SessionEndEventSchema,      // 触发 LLM 档案更新
  WordLookupEventSchema,      // 点词查词 → 状态机
  WordKnownEventSchema,       // 主动标记认识 → mastered
  MaterialCompletedEventSchema / MaterialAbandonedEventSchema / FeedbackEventSchema,
]);
```

事件 append-only 落库,引擎以事件时间 `ts` 为准 —— 这是**可回放**(sim/replay.ts)的基础。事件可携带客户端生成的 `event_id`(幂等键,重试时复用),写入时按 `(user_id, event_id)` 去重;`session_end` 始终按 `(user_id, session_id)` 去重。

## 5. 引擎门面 `lib/engine/engine.ts`

`createEngine()` 组装 storage + llm,`processEvent` 是分发器。事件携带客户端幂等键 `event_id`(可选),`session_end` 另按 `(user_id, session_id)` 天然去重;重复事件只记账一次、跳过副作用。每个事件的 `insertEvent` + 副作用写在**单个同步事务**里,失败整体回滚;LLM 调用(异步)在事务外完成,只产出待写入集(`computeSessionUpdate` → `applyPendingWrites`):

```ts
async function processEvent(ev: ReadingEvent) {
  if (isDuplicateEvent(ev)) return { duplicate: true };  // 幂等键预检(省掉重复 LLM 调用)
  if (ev.type === "session_end") {
    const exposureWrites = planExposures(...);           // 先算曝光(只算不写)
    const { writes } = await computeSessionUpdate(...);  // LLM 尺度 2/3,事务外
    storage.transaction(() => {                          // 单事务落库,失败整体回滚
      if (!storage.insertEvent(ev)) return;              // 重复事件(重试/重投):跳过副作用
      applyPendingWrites(storage, exposureWrites);
      applyPendingWrites(storage, writes);
    });
    return;
  }
  storage.transaction(() => {                            // 其余事件:insertEvent + 同步副作用
    if (!storage.insertEvent(ev)) return;
    // session_start → saveMaterial;word_lookup/word_known → 知识状态机;其余只进事件流
  });
}
```

摄入幂等:事件可携带客户端生成的 `event_id`,服务端按 `(user_id, event_id)` 唯一索引去重;`session_end` 语义上一个会话只结束一次,落库时统一改写为合成键 `session_end:<session_id>`(即使重发换了新 `event_id`)。重复事件只返回成功、不重跑副作用。每个事件的 `insertEvent` + 副作用写在**单个同步事务**里,失败整体回滚;LLM 调用(异步)在事务外完成,只产出待写入集(`computeSessionUpdate` → `applyPendingWrites`),因此 LLM 失败不会留下半截状态,客户端重试可完整重放(issue #9)。

`accountExposures`(现为 `planExposures`) 是个巧妙的点:session 结束时,把材料正文分词,凡是**账本里出现过、本 session 没查**的词,记一次「无查询曝光」——这正是「这个词用户在语境里没查就读过去了」的证据,驱动 familiar→mastered。

## 6. 知识点状态机 `lib/engine/knowledge.ts`

确定性纯函数,零依赖,单测全覆盖。状态迁移图:

```
                查词              后续 session 出现未查        累计 3 次无查询曝光
null ──lookup──▶ new ──lookup──▶ supported ──exposure──▶ familiar ──────────▶ mastered
                    ▲                  │                         │                ▲
                    └──────────────────┴──── 查了就是还需要辅助 ──┴────────────────┘ (回退 supported)
                                                     │
                            familiar 14 天 / mastered 30 天未出现(惰性)
                                                     ▼
                                              fading(不落库,查询时算)
```

两个关键设计:

**惰性 fading**:`fading` 不是存的状态,是读取时算的 ——

```ts
// lib/engine/knowledge.ts
export function effectiveState(item: KnowledgeItem, now: string): KnowledgeState {
  const threshold = FADING_DAYS[item.state];        // familiar: 14, mastered: 30
  if (threshold !== undefined && daysBetween(item.last_seen, now) > threshold) {
    return "fading";
  }
  return item.state;
}
```

好处:不需要定时任务;fading 的词重新出现且未查时,一次 exposure 就「复活」为 familiar。

**LLM 回流白名单**:尺度 2 的 LLM 可以建议改某个词的状态(`knowledge_annotations`),但必须过代码校验 —— 该词确实在本 session 出现过 + 迁移在合法邻接表内:

```ts
export const LEGAL_TRANSITIONS: Record<KnowledgeState, KnowledgeState[]> = {
  new: ["supported", "familiar"],
  supported: ["new", "familiar"],
  familiar: ["supported", "fading"],
  mastered: ["supported", "fading"],
  fading: ["supported", "familiar"],
}; // 不允许 new→mastered 这种跃迁
```

## 7. 三个时间尺度 `lib/engine/profiler.ts`

防震荡的结构性方案,digest(确定性文本摘要)是 LLM 的唯一输入:

| 尺度 | 触发 | LLM 能动什么 | 代码约束 |
|---|---|---|---|
| 1 每事件 | lookup/known/曝光 | — | 状态机 |
| 2 每 session | session_end | 篇幅/速度/兴趣/notes | schema 无 band;length ±20%、wpm ±10% clamp |
| 3 每 5 session | 尺度 2 后检查 | band/vocab(可拒绝) | 滞回 gate;band ≤1 级、vocab ±20% |

**digest**(`lib/engine/digest.ts`):事件流 → 紧凑 `key=value` 文本,如
`lookup_density=4.20% completion_rate=100% reading_speed_wpm=132`。格式稳定,既给 LLM 读,也让 MockLLMClient 和测试能机械解析。

**clamp** 是代码强制的,不依赖 prompt 自觉:

```ts
export function clampInt(proposed: number, current: number, pct: number): number {
  const lo = Math.floor(current * (1 - pct));
  const hi = Math.ceil(current * (1 + pct));
  return Math.min(hi, Math.max(lo, Math.round(proposed)));
}
```

**滞回 gate**:最近 3 个 session 查词密度全部 <1%(或用户显式反馈全部「太简单」)才允许升级、全部 >5%(或全部「太难」)才允许降级;两方向信号矛盾则 hold;gate=hold 时**根本不调 LLM**,省钱又防震:

```ts
export function stageGate(recentSessionDigests: string[]): StageGate {
  const recent = recentSessionDigests.slice(-HYSTERESIS_SESSIONS);
  const densities = recent.map(parseLookupDensity).filter((d): d is number => d !== null);
  if (densities.length < HYSTERESIS_SESSIONS) return "hold";
  const votes = recent.map(parseDifficultyVote); // feedback 事件里的 difficulty 字段
  const wantUp = densities.every((d) => d < HYSTERESIS_UP_DENSITY) || votes.every((v) => v === "too_easy");
  const wantDown = densities.every((d) => d > HYSTERESIS_DOWN_DENSITY) || votes.every((v) => v === "too_hard");
  if (wantUp && !wantDown) return "up";
  if (wantDown && !wantUp) return "down";
  return "hold";
}
```

难度反馈来自阅读页的「太简单 / 合适 / 太难」按钮(`feedback` 事件的可选 `difficulty` 字段),与密度信号平级、走同样的 3 次同向滞回窗口。

每次更新都写 `update_journal`(prompt 版本/模型/输入 digest/原始响应/delta/token 用量),`/debug/[userId]` 页就是journal 的可视化。

## 8. 材料生成引擎 `lib/engine/generator.ts` + `textcheck.ts`

### 8.1 TargetSpec:给生成器的「订单」

`buildTargetSpec` 把用户模型翻译成生成约束:band、篇幅区间、兴趣 top3、**review_items**(fading/supported 旧词,要求文中重现,自然间隔重复)、**new_item_budget**(≈ 舒适篇幅 × 目标查词率下限)、**avoid_items**(new 状态且查了 ≥3 次 —— 显挫折,暂缓)。

### 8.2 Agentic loop:LLM 提议,代码裁决

LLM 每轮只输出一个动作(`contracts/generator.ts` 的判别联合):

```ts
export const GeneratorTurnSchema = z.discriminatedUnion("action", [
  CheckWordsTurnSchema,   // check_words: 草稿前先问系统这些词用户认不认识
  CheckDraftTurnSchema,   // check_draft: 请求整篇体检
  SubmitTurnSchema,       // submit: 交稿
]);
```

循环(`generateMaterial`,最多 8 轮):LLM 输出 turn → 代码执行并把结果以 `TOOL_RESULT` 回传 → submit/check_draft 的草稿过 `checkDraft` 验收闸门,pass 即采纳;到轮数上限没 pass 就返回历史最佳草稿 + warnings。

### 8.3 验收闸门 `checkDraft`:N+1 的数字化

每个 token 分类(`textcheck.ts`):

```ts
export type WordClass =
  | "known_ledger"   // 账本 familiar/mastered → 已知
  | "review_ledger"  // 账本 supported/fading → 刻意重现,不计入生词率
  | "new_ledger"     // 账本 new → 硬生词
  | "known_rank"     // 未跟踪,词频 rank < vocab×0.98 → 已知
  | "stretch"        // 未跟踪,rank ≥ vocab×0.98 → N+1 拉伸区
  | "untracked";     // 无法判定,保守按生词计
```

五条验收标准全部通过才 `pass`:篇幅在区间、predicted_lookup_rate ≤ 目标上限(即 ≥95~98% 覆盖)、新词数 ≤ 预算、无 avoid 词、review 词 ≥80% 出现。**验收权完全在代码**,LLM 自报的 new_items 只是对照。

词频 rank 来自 `lib/engine/lexicon-en.json`(`scripts/build-lexicon.py` 构建;sim 环境用合成词表 `wordAt`)。

## 9. LLM 抽象 `lib/engine/llm.ts`

```ts
export interface LLMClient {
  complete<T>(req: LLMRequest<T>): Promise<LLMResult<T>>;  // messages + zod schema → 解析后的 T
  modelName(): string;
}
```

- **OpenAICompatibleClient**:env `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`,temperature=0;zod 校验失败把错误反馈给模型重试一次;`response_format` 按 `json_schema → json_object → 无` 自动降级(兼容不支持 json_schema 的端点)。
- **MockLLMClient**:解析 digest 里的数字机械生成合法输出,供测试与无 key 演示。
- `createLLMClient()`:有 `LLM_API_KEY` 用真实,否则 Mock。

引擎其余部分只依赖 `LLMClient` 接口 —— 测试和仿真的确定性由此而来。

### 9.1 调用追踪 `lib/engine/llm-trace.ts`

`createEngine()` 在 `complete()` 层（全部 LLM 流量的唯一 chokepoint）用 `withLLMTracing` 统一包装：每次调用**双写** —— SQLite `llm_calls` 表（含完整 messages/raw、token、延迟、估算成本、错误；重试合并为一条）+ pino 结构化日志。调用点通过 `LLMRequest.trace`（可选）带上 userId/sessionId/scale/turn 上下文。成本由 token 数 × 单价表估算，未知模型可用 env `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` 配置。

### 9.2 日志 `lib/logger.ts`

pino，stdout + 文件双写（`LOG_FILE`，默认 `data/app.log`），级别由 `LOG_LEVEL` 控制（默认 info）。LLM 调用单独再落一份 JSONL（`LLM_LOG_FILE`，默认 `data/llm-calls.jsonl`），便于采集。单例挂 `globalThis`（HMR 安全，同 `getDefaultStorage` 模式），不用 pino transport（worker thread 与 Next bundling 有坑），文件写走 `pino.destination()`。不依赖 Next.js，sim 脚本同样可用。两个触发 LLM 的 API 路由（events / materials）用 child logger 记录请求开始/结束/错误，与 `llm_calls` 可通过 user_id + 时间窗关联。

## 10. 存储 `lib/engine/storage.ts`

SQLite(better-sqlite3 + drizzle),10 张表:

| 表 | 内容 |
|---|---|
| `events` | append-only 事件流(回放的事实源) |
| `profiles` + `profile_snapshots` | 当前档案 + 每次版本历史 |
| `knowledge_items` + `knowledge_changes` | 词汇账本 + 每个词的状态史(含触发源) |
| `materials` | 生成的材料(含正文,按 `(user_id, material_id)` 隔离) |
| `update_journal` | 每次 LLM 更新的完整审计 |
| `llm_calls` | 每次 LLM 调用的观测记录(输入 messages/原始响应/token/延迟/成本/错误) |
| `accounts` | 规范化邮箱、用户 ID 与显示昵称 |
| `auth_sessions` | 会话 token 哈希、归属用户与过期时间 |

启动时 `CREATE TABLE IF NOT EXISTS` 自动建表;`getDefaultStorage()` 是 HMR 安全的单例(挂在 globalThis)。`replay()` 用全量事件在内存库重放推导 profile,与当前对比,暴露记忆漂移。

## 11. API 与 UI `app/`

API 是引擎的薄壳:

| 路由 | 作用 |
|---|---|
| `POST /api/auth/login` | 邮箱免密码、免验证码登录;新邮箱自动创建账号 |
| `POST /api/auth/logout` | 删除当前会话并退出 |
| `POST /api/events` | 当前用户的事件摄入(单个或数组,zod 校验;`event_id` 幂等去重,失败返回非 2xx + 逐事件状态) |
| `POST /api/users` | 当前账号建档(onboarding):band → 词汇量默认映射(`lib/band-vocab.ts`) |
| `POST /api/users/[id]/reassess` | 重新测评:重置 reading_state,可选清空词汇账本 |
| `GET /api/users/[id]/target-spec` | 消费接口:当前生成约束 |
| `POST /api/users/[id]/materials` | 生成一篇材料(同步,agentic loop 可能十几秒;并发互斥 409 + 冷却/每日配额 429 + token 限额 429) |

学习数据接口要求有效会话,并校验路径或事件中的用户 ID 属于当前账号。

页面(清爽阅读型,CSS Modules):

- `/login` 单邮箱登录;`/onboarding` 完成昵称、水平与兴趣设置;会话有效期 30 天,Cookie 为 HttpOnly,数据库不保存原始 token。
- `/` 当前账号仪表盘(server component 通过 `getCurrentAccount()` 读取会话;`export const instant = false` 用于 cacheComponents 模式下的动态页)。
- `/read/[userId]` 阅读界面 → `/profile/[userId]` 档案 → `/reassess/[userId]` 重新测评,均校验账号归属。
- `/debug/[userId]` 当前账号的引擎内部可视化(profile 版本史、知识点分组、journal 时间线、LLM 调用明细与成本汇总)。

**阅读界面 `app/read/[userId]/read-session.tsx`** 是事件流的来源,状态机
`idle → generating → reading → closing → done`:
生成材料 → 发 `session_start` → 正文按词渲染,点词开浮层即发 `word_lookup`、可标记 `word_known` → 完成/放弃/点赞 → 最后 `session_end` 触发尺度 2 更新。

## 12. 仿真 `sim/`

不真实用户验证引擎:

- `pnpm sim:personas`:5 种画像(初学者/进阶者/兴趣漂移/遗忘者/震荡压力)跑全流程,输出估计质量指标;
- `pnpm sim:eval`:留出集预测(后 20% session),with-knowledge vs profile-only 对比,验证分层建模的价值;
- `pnpm sim:tune`:clamp 幅度 × K 的网格对比(调 `profiler.ts` 顶部的常量旋钮);
- `pnpm sim:replay <userId>`:事件重放 vs 当前 profile;
- `pnpm demo`:Mock 下全流程闭环演示。

## 13. 一次完整阅读 session 的时序

```
用户点「生成今日材料」
  POST /api/users/[id]/materials
    └─ generateMaterial: buildTargetSpec → LLM check_words/check_draft/submit
       → checkDraft 验收 → saveMaterial + journal
进入阅读:POST /api/events [session_start(带正文)]
点词:      POST /api/events [word_lookup ×N]   → 状态机即时:new→supported
「我认识」: POST /api/events [word_known]       → 直接 mastered
完成:      POST /api/events [material_completed, feedback?]
结束:      POST /api/events [session_end]
    └─ planExposures(文中出现未查的账本词 +1 exposure → familiar/mastered)
    └─ computeSessionUpdate: digest → LLM → clamp → 版本+1 → 与事件行同事务落库 + journal
    └─ 每 5 个 session:stageGate 放行? → computeStageReview → band/vocab 调整
下次生成:review_items 带回 fading/supported 旧词 —— 闭环完成
```

## 14. 测试布局 `tests/`

重点是**纯函数**:`knowledge.test.ts`(状态机全迁移)、`clamp.test.ts`(clamp/gate)、`digest.test.ts`、`generator.test.ts`(验收闸门)、`llm.test.ts`(重试/Mock/客户端选择)、`llm-trace.test.ts`(成本估算/追踪双写/生成器每 turn 一条)、`contracts.test.ts`(schema)、`replay.test.ts`、`profiler.test.ts`、`idempotency.test.ts`(事件幂等去重)、`quota.test.ts`(token 限额)、`generation-guard.test.ts`(生成防滥用)、`materials.test.ts`(材料按用户隔离)。运行 `pnpm test`。
