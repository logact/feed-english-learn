# feed-english-learn

中文 | [English](README.en.md)

基于**可理解性输入(Comprehensible Input)**理念的自适应英语学习系统:自动维护用户水平与兴趣模型,持续生成 N+1 难度(覆盖 95%~98% 已掌握词汇)的阅读材料,让用户在流畅、正向情绪的阅读中习得英语。

## 产品基本功能

- **邮箱免密登录**:输入邮箱即可登录,新邮箱自动建号;会话 30 天,HttpOnly Cookie,数据库只存 token 哈希。
- **Onboarding 建档**:设置昵称、当前水平(band)与兴趣,作为冷启动档案;支持后续重新测评(`/reassess`)。
- **个性化材料生成**:根据用户水平、词汇账本与兴趣,由 LLM 生成篇幅合适、难度经代码验收的阅读材料;材料中刻意重现遗忘中的旧词(间隔重复)。
- **阅读界面**:正文按词渲染,点词查词、可标记「我认识」;完成后可反馈「太简单 / 合适 / 太难」。
- **自适应学习闭环**:每次阅读的行为(查词、曝光、速度、完成度、反馈)回流更新用户模型,下一次生成的材料随之调整。
- **个人档案页**:查看当前水平估计、兴趣与阅读状态。
- **Debug 可视化**(`/debug/[userId]`):档案版本历史、词汇状态分组、每次 LLM 更新的审计时间线、LLM 调用明细与成本汇总。

### 自适应闭环(产品主流程)

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

## 核心功能的逻辑实现

设计哲学一句话:**代码告诉 LLM「发生了什么」,LLM 告诉系统「这意味着什么」**。所有数字裁决(状态迁移、clamp、滞回、材料验收)都在确定性代码里;LLM 只做解读(档案更新)和创作(写材料),且都被代码 gate。详见 [docs/how-it-works.md](docs/how-it-works.md) 与 [docs/user-engine.md](docs/user-engine.md)。

### 两层用户模型

- **UserProfile(慢变量,LLM 维护)**:对「未见词难度」的泛化判断 —— band、词汇量估计、舒适篇幅、阅读速度、兴趣。解决冷启动和非词汇信号(速度、放弃)。
- **KnowledgeItem(快变量,代码记账)**:每个具体词的掌握状态,由确定性状态机维护:

```
              查词            后续 session 出现未查      累计 3 次无查询曝光
null ──lookup──▶ new ──lookup──▶ supported ──exposure──▶ familiar ──────────▶ mastered
                  ▲                │                       │                ▲
                  └────────────────┴──── 查了就是还需要辅助 ─┴────────────────┘
                                       familiar 14 天 / mastered 30 天未出现 → fading(惰性计算)
```

### 三个时间尺度(防震荡的结构性方案)

| 尺度 | 触发 | LLM 能动什么 | 代码约束 |
|---|---|---|---|
| 1 每事件 | 查词/标记认识/曝光 | — | 词汇状态机(纯函数,单测全覆盖) |
| 2 每 session | session_end | 篇幅/速度/兴趣/notes | 输出 schema 不含 band;篇幅 ±20%、速度 ±10% 由代码 clamp |
| 3 每 5 session | 尺度 2 后检查 | band/词汇量(可拒绝) | 滞回 gate:最近 3 个 session 信号连续同向才放行;band 每次最多 1 级 |

LLM 更新档案的唯一输入是 **digest**(事件流压缩成的稳定格式文本摘要);每次更新的 prompt 版本、原始响应、实际 delta 都写入 `update_journal`,可审计、可回放。

### 材料生成:LLM 提议,代码裁决

1. **TargetSpec(订单)**:把用户模型翻译成生成约束 —— band、篇幅区间、兴趣 top3、review_items(要求重现的旧词)、新词预算、avoid_items(查了多次仍生的挫折词,暂缓)。
2. **Agentic loop(最多 8 轮)**:LLM 每轮输出一个动作 —— `check_words`(问系统这些词用户认不认识)、`check_draft`(请求整篇体检)、`submit`(交稿);代码执行后以 `TOOL_RESULT` 回传。
3. **验收闸门 checkDraft(N+1 的数字化)**:每个词按「账本状态 + 词频 rank」分类,五条标准(篇幅在区间、预测查词率 ≤ 上限即 ≥95~98% 覆盖、新词数 ≤ 预算、无 avoid 词、review 词 ≥80% 出现)全部通过才采纳。**验收权完全在代码**。

### 事件流与存储

- UI 与引擎之间唯一的写入通道是 7 种阅读事件(`contracts/events.ts`),append-only 落库,携带 `event_id` 幂等键去重,支持完整重放(`sim/replay.ts`)。
- 每个事件的写入与副作用在单个事务里完成;LLM 调用在事务外,失败不留半截状态。
- SQLite(better-sqlite3 + drizzle)10 张表:事件流、档案与版本史、词汇账本与状态史、材料、更新审计、LLM 调用观测、账号与会话。

## 快速开始

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

不配置 LLM key 时使用内置 MockLLMClient,可完整体验闭环;配置后走真实模型。

### 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | LLM 服务配置(OpenAI 兼容端点);无 key 时使用内置 Mock | `gpt-4o-mini` |
| `DAILY_TOKEN_LIMIT` | 每用户每日 token 限额(prompt + completion 合计),`0` 表示不限 | `100000` |
| `SYSTEM_DAILY_TOKEN_LIMIT` | 系统每日 token 总限额(所有用户合计),`0` 表示不限 | 不限 |
| `ENGINE_DB_PATH` | SQLite 数据库路径 | `data/engine.db` |
| `LOG_LEVEL` / `LOG_FILE` / `LLM_LOG_FILE` | 日志级别与文件路径 | `info` / `data/app.log` / `data/llm-calls.jsonl` |
| `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` | 自建端点模型的 token 单价(美元/1M),用于成本估算 | 内置价格表 |

超出限额后所有 LLM 调用被拦截:材料生成接口返回 429,后台档案更新静默跳过(次日 UTC 零点重置)。

### 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | 开发 / 构建 / 生产启动 |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | 测试 / 类型检查 / lint |
| `pnpm demo` | Mock 下全流程闭环演示 |
| `pnpm sim:personas` | 5 种虚拟画像跑全流程,输出估计质量指标 |
| `pnpm sim:eval` | 留出集预测对比(验证分层建模价值) |
| `pnpm sim:replay <userId>` | 事件重放推导 vs 当前档案,暴露记忆漂移 |
| `pnpm contracts:export` | 导出契约层 JSON Schema |

## 目录结构

| 目录 | 角色 |
|---|---|
| `contracts/` | 全部跨模块数据结构(zod schema),系统的「语言」 |
| `lib/engine/` | 引擎核心,不依赖 Next.js,可在 tsx/vitest 独立运行 |
| `app/` | Next.js UI + API 薄壳,只做「HTTP ↔ engine」翻译 |
| `sim/` | 仿真:虚拟用户画像跑全流程,验证引擎质量 |
| `tests/` | vitest,重点覆盖纯函数(状态机/clamp/digest/验收) |
| `docs/` | [工作原理导览](docs/how-it-works.md)、[用户引擎设计](docs/user-engine.md)、[PRD](PRD.md) |
