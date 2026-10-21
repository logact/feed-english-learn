# 组件 1：用户基本信息分析引擎（设计文档）

实现计划见 session plans；本文档是落地后的参考说明。

## 架构一句话

代码告诉 LLM「发生了什么」，LLM 告诉系统「这意味着什么」。知识点层是确定性记账层，概览层（UserProfile）是 LLM 维护的解读层。

## 两层用户模型

- **UserProfile**（慢变量，LLM 维护）：band、vocab_estimate、confidence、target_lookup_rate、comfortable/max_length、reading_speed_wpm、interests、notes、evidence。schema 见 `contracts/profile.ts`。
- **KnowledgeItem**（快变量，代码记账）：每个词 new→supported→familiar→mastered，外加惰性 fading（familiar 14 天 / mastered 30 天未出现）。状态机是纯函数，见 `lib/engine/knowledge.ts`。

为什么必须两层：未见词泛化（band/vocab 是对未见词难度的泛化结论）、冷启动、非词汇信号（速度/放弃/篇幅耐受）无词汇可归。

## 三个时间尺度（防震荡的结构性方案）

| 尺度 | 触发 | 执行者 | 约束 |
|---|---|---|---|
| 1 每事件 | word_lookup / word_known / session 末曝光 | 确定性代码 | 状态机单测全覆盖 |
| 2 每 session | session_end | LLM | 输出 schema 结构性不含 band/vocab_estimate；length ±20%、wpm ±10% 由代码 clamp |
| 3 阶段检查 | 每 K=5 个 session | LLM | 滞回 gate：最近 3 session 查词密度同向（全 <1% 才允许升、全 >5% 才允许降）；band 最多一级、vocab ±20% |

尺度 2 的 LLM 输出可带 `knowledge_annotations`（≤20 条回流审核）：代码校验「item 必须在本 session 出现过 + 迁移合法」后应用并记 knowledge_changes（trigger=llm_annotation）。

## 存储（SQLite，data/engine.db）

9 张表：events（append-only）、profiles、profile_snapshots（版本历史）、knowledge_items、knowledge_changes（含每个词的状态史）、materials、update_journal（每次 LLM 更新的 prompt 版本/模型/输入 digest/原始响应/delta）、accounts（邮箱账号）、auth_sessions（登录会话）。启动时自动 CREATE TABLE IF NOT EXISTS；也可用 `pnpm db:push`（注意：push 要在 fresh db 上跑，或交给自动建表）。

## 邮箱登录

`/login` 输入邮箱即可登录，不使用密码或邮箱验证码。邮箱规范化后唯一对应一个账号；新邮箱自动创建账号并进入 onboarding，已有档案则直接回到首页。会话有效期 30 天，浏览器保存 HttpOnly Cookie，数据库只保存 token 的 SHA-256 哈希。此方式不验证邮箱归属，仅适合轻量产品或演示环境。学习页面和用户 API 都会校验当前会话与 userId 的归属。

## 消费接口（给组件 2 材料生成引擎）

`GET /api/users/[id]/target-spec` → band、length_words、topics、review_items（fading/supported 旧词重现清单）、new_item_budget、avoid_items、notes。调用时需携带当前账号的会话 Cookie，且 id 必须属于该账号。

## LLM 接入

`lib/engine/llm.ts`：LLMClient 接口（messages + Zod schema → 解析后的 JSON）。
- `OpenAICompatibleClient`：env `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`，temperature=0，校验失败带错误反馈重试一次，token 统计。
- `MockLLMClient`：确定性启发式（解析 digest 中的 lookup_density 等数字机械生成合法输出），供测试与无 key 演示。
- 默认按有无 LLM_API_KEY 选择。

## 仿真与测量（sim/）

- `pnpm sim:personas`：5 画像（初学者/进阶者/兴趣漂移/遗忘者/震荡压力），第 2 层估计质量指标。Mock 下断言「流程跑通+指标输出」，真实 key 下断言收敛阈值（见 runner.ts assertRealLlmThresholds）。
- `pnpm sim:eval [persona]`：第 3 层留出集预测（后 20% session），with-knowledge vs profile-only 两变体对比（验证分层建模价值）。
- `pnpm sim:tune`：clamp 幅度 × K 网格对比。
- `pnpm sim:replay <userId> [db]`：全量事件重放推导 vs 当前 profile，暴露记忆漂移。

## 调试

- `/debug` → `/debug/[userId]`：profile 当前值与版本历史、知识点按状态分组、知识点状态史、journal 时间线（digest/原始响应/delta）。
- `pnpm demo`：Mock 下全流程闭环演示。
