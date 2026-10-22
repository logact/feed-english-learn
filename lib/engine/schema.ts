import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    ts: text("ts").notNull(),
    payload: text("payload").notNull(), // 完整事件 JSON
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_events_user").on(t.userId, t.sessionId)],
);

export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  version: integer("version").notNull(),
  data: text("data").notNull(), // UserProfile JSON
  updatedAt: text("updated_at").notNull(),
});

export const profileSnapshots = sqliteTable(
  "profile_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    version: integer("version").notNull(),
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_snapshots_user").on(t.userId, t.version)],
);

export const knowledgeItems = sqliteTable(
  "knowledge_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    item: text("item").notNull(),
    itemType: text("item_type").notNull(),
    state: text("state").notNull(),
    lookupCount: integer("lookup_count").notNull(),
    exposureCount: integer("exposure_count").notNull(),
    firstSeen: text("first_seen").notNull(),
    lastSeen: text("last_seen").notNull(),
    lastLookupTs: text("last_lookup_ts"),
    lastLookupSession: text("last_lookup_session"),
    nextReview: text("next_review"),
    note: text("note"),
    sampleContexts: text("sample_contexts").notNull(), // JSON array
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_knowledge_user_item").on(t.userId, t.item),
    index("idx_knowledge_user_state").on(t.userId, t.state),
  ],
);

export const knowledgeChanges = sqliteTable(
  "knowledge_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    sessionId: text("session_id"),
    item: text("item").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    trigger: text("trigger").notNull(),
    note: text("note"),
    ts: text("ts").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_kchanges_user").on(t.userId, t.item)],
);

export const materials = sqliteTable("materials", {
  materialId: text("material_id").primaryKey(),
  data: text("data").notNull(), // MaterialMeta JSON
  createdAt: text("created_at").notNull(),
});

export const updateJournal = sqliteTable(
  "update_journal",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    scale: text("scale").notNull(), // 'session' | 'stage_review'
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    inputSummary: text("input_summary").notNull(), // digest 原文
    rawResponse: text("raw_response").notNull(),
    delta: text("delta").notNull(), // JSON：本次更新前后差异
    usage: text("usage"), // JSON：token 统计
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_journal_user").on(t.userId, t.id)],
);

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id"), // 可空：sim/eval 无用户上下文
    sessionId: text("session_id"), // 可空：stage_review / generate 无会话
    scale: text("scale").notNull(), // 'session' | 'stage_review' | 'generate' | 'predict'
    schemaName: text("schema_name").notNull(), // 逻辑契约名（ProfileSessionUpdate 等）
    promptVersion: text("prompt_version"),
    turn: integer("turn"), // 生成器回合号，其他为 null
    model: text("model").notNull(),
    messages: text("messages").notNull(), // 完整输入 messages JSON
    rawResponse: text("raw_response"), // 错误时 null
    status: text("status").notNull(), // 'ok' | 'error'
    error: text("error"),
    attempts: integer("attempts"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    costUsd: real("cost_usd"), // token 数 × 单价表估算，未知模型为 null
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_llm_calls_user").on(t.userId, t.id),
    index("idx_llm_calls_session").on(t.sessionId),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    userId: text("user_id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_accounts_email").on(t.email)],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_auth_sessions_user").on(t.userId)],
);
