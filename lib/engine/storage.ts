import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, and, desc, asc } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";
import type { ReadingEvent } from "../../contracts/events";
import type { UserProfile } from "../../contracts/profile";
import type { KnowledgeItem, KnowledgeChange } from "../../contracts/knowledge";
import type { MaterialMeta } from "../../contracts/events";

export const DEFAULT_DB_PATH = process.env.ENGINE_DB_PATH ?? "data/engine.db";

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts TEXT NOT NULL,
  event_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, session_id);
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON profile_snapshots(user_id, version);
CREATE TABLE IF NOT EXISTS knowledge_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  item TEXT NOT NULL,
  item_type TEXT NOT NULL,
  state TEXT NOT NULL,
  lookup_count INTEGER NOT NULL,
  exposure_count INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_lookup_ts TEXT,
  last_lookup_session TEXT,
  next_review TEXT,
  note TEXT,
  sample_contexts TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_user_item ON knowledge_items(user_id, item);
CREATE INDEX IF NOT EXISTS idx_knowledge_user_state ON knowledge_items(user_id, state);
CREATE TABLE IF NOT EXISTS knowledge_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT,
  item TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  trigger TEXT NOT NULL,
  note TEXT,
  ts TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kchanges_user ON knowledge_changes(user_id, item);
CREATE TABLE IF NOT EXISTS materials (
  user_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, material_id)
);
CREATE TABLE IF NOT EXISTS update_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  scale TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  delta TEXT NOT NULL,
  usage TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_user ON update_journal(user_id, id);
CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts(email);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
`;

export interface JournalEntry {
  id: number;
  userId: string;
  scale: string;
  promptVersion: string;
  model: string;
  inputSummary: string;
  rawResponse: string;
  delta: Record<string, unknown>;
  usage: { promptTokens?: number; completionTokens?: number } | null;
  createdAt: string;
}

export interface KnowledgeRow extends KnowledgeItem {
  userId: string;
  updatedAt: string;
}

export interface Account {
  userId: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface AuthSession {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export type DB = BetterSQLite3Database<typeof schema>;

/** 事件的幂等键：session_end 用合成键（语义上一个会话只结束一次），其余用客户端 event_id；null=不去重 */
export function dedupKeyOf(ev: ReadingEvent): string | null {
  return ev.type === "session_end" ? `session_end:${ev.session_id}` : (ev.event_id ?? null);
}

export interface Storage {
  db: DB;
  sqlite: Database.Database;
  close(): void;
  /** 同步事务：fn 抛错则整体回滚（better-sqlite3 单连接，嵌套自动转 savepoint） */
  transaction<T>(fn: () => T): T;

  /** 幂等写入：返回 true=新插入，false=重复事件（同 user 下同幂等键已存在） */
  insertEvent(ev: ReadingEvent): boolean;
  /** 幂等键是否已存在（用于在昂贵的 LLM 计算前预检重复事件） */
  hasEventId(userId: string, eventId: string): boolean;
  listEvents(userId: string): ReadingEvent[];
  listSessionEvents(userId: string, sessionId: string): ReadingEvent[];
  lastEventTs(userId: string): string | null;

  getProfile(userId: string): UserProfile | null;
  saveProfile(profile: UserProfile): void;
  listSnapshots(userId: string): UserProfile[];
  listUserIds(): string[];

  createAccount(account: Account): void;
  getAccountByEmail(email: string): Account | null;
  getAccountById(userId: string): Account | null;
  updateAccountDisplayName(userId: string, displayName: string): void;
  createAuthSession(session: AuthSession): void;
  getAuthSession(tokenHash: string): AuthSession | null;
  deleteAuthSession(tokenHash: string): void;

  getKnowledgeItem(userId: string, item: string): KnowledgeItem | null;
  upsertKnowledgeItem(userId: string, item: KnowledgeItem, updatedAt: string): void;
  listKnowledgeItems(userId: string): KnowledgeItem[];
  insertKnowledgeChange(change: KnowledgeChange): void;
  listKnowledgeChanges(userId: string, item?: string): KnowledgeChange[];

  saveMaterial(userId: string, meta: MaterialMeta): void;
  getMaterial(userId: string, materialId: string): MaterialMeta | null;

  insertJournal(entry: Omit<JournalEntry, "id">): void;
  listJournal(userId: string): JournalEntry[];

  clearKnowledge(userId: string): void;
  wipeUser(userId: string): void;
}

function parseKnowledgeRow(r: typeof schema.knowledgeItems.$inferSelect): KnowledgeItem {
  return {
    item: r.item,
    item_type: r.itemType as KnowledgeItem["item_type"],
    state: r.state as KnowledgeItem["state"],
    lookup_count: r.lookupCount,
    exposure_count: r.exposureCount,
    first_seen: r.firstSeen,
    last_seen: r.lastSeen,
    last_lookup_ts: r.lastLookupTs,
    last_lookup_session: r.lastLookupSession,
    next_review: r.nextReview,
    note: r.note,
    sample_contexts: JSON.parse(r.sampleContexts) as string[],
  };
}

export function createStorage(dbPath: string = DEFAULT_DB_PATH): Storage {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  // materials 旧表无 user_id（材料为可再生内容，直接重建）
  const materialCols = sqlite.prepare("PRAGMA table_info(materials)").all() as { name: string }[];
  if (materialCols.length > 0 && !materialCols.some((c) => c.name === "user_id")) {
    sqlite.exec("DROP TABLE materials");
  }
  sqlite.exec(DDL);
  // 旧库迁移：events 表补 event_id 幂等键列（新库 DDL 已含）
  const cols = sqlite.prepare("PRAGMA table_info(events)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "event_id")) {
    sqlite.exec("ALTER TABLE events ADD COLUMN event_id TEXT");
  }
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_events_user_event ON events(user_id, event_id)",
  );
  const db = drizzle(sqlite, { schema });
  const now = () => new Date().toISOString();
  const tx = <T>(fn: () => T): T => sqlite.transaction(fn)();

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
    transaction: tx,

    insertEvent(ev) {
      // 幂等键:session_end 语义上一个会话只结束一次,始终按 (user_id, session_id) 去重
      // (即使客户端重发时生成了新 event_id);其余事件按客户端 event_id 去重,无键则不去重
      const eventId = dedupKeyOf(ev);
      const res = db
        .insert(schema.events)
        .values({
          userId: ev.user_id,
          sessionId: ev.session_id,
          type: ev.type,
          ts: ev.ts,
          eventId,
          payload: JSON.stringify(ev),
          createdAt: now(),
        })
        .onConflictDoNothing({ target: [schema.events.userId, schema.events.eventId] })
        .run();
      return res.changes > 0;
    },

    hasEventId(userId, eventId) {
      const rows = db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(and(eq(schema.events.userId, userId), eq(schema.events.eventId, eventId)))
        .limit(1)
        .all();
      return rows.length > 0;
    },

    listEvents(userId) {
      return db
        .select()
        .from(schema.events)
        .where(eq(schema.events.userId, userId))
        .orderBy(asc(schema.events.ts), asc(schema.events.id))
        .all()
        .map((r) => JSON.parse(r.payload) as ReadingEvent);
    },

    listSessionEvents(userId, sessionId) {
      return db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.userId, userId), eq(schema.events.sessionId, sessionId)))
        .orderBy(asc(schema.events.ts), asc(schema.events.id))
        .all()
        .map((r) => JSON.parse(r.payload) as ReadingEvent);
    },

    lastEventTs(userId) {
      const rows = db
        .select({ ts: schema.events.ts })
        .from(schema.events)
        .where(eq(schema.events.userId, userId))
        .orderBy(desc(schema.events.ts), desc(schema.events.id))
        .limit(1)
        .all();
      return rows[0]?.ts ?? null;
    },

    getProfile(userId) {
      const rows = db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).all();
      return rows[0] ? (JSON.parse(rows[0].data) as UserProfile) : null;
    },

    saveProfile(profile) {
      tx(() => {
        db.insert(schema.profiles)
          .values({
            userId: profile.user_id,
            version: profile.version,
            data: JSON.stringify(profile),
            updatedAt: profile.updated_at,
          })
          .onConflictDoUpdate({
            target: schema.profiles.userId,
            set: { version: profile.version, data: JSON.stringify(profile), updatedAt: profile.updated_at },
          })
          .run();
        db.insert(schema.profileSnapshots)
          .values({
            userId: profile.user_id,
            version: profile.version,
            data: JSON.stringify(profile),
            createdAt: now(),
          })
          .run();
      });
    },

    listSnapshots(userId) {
      return db
        .select()
        .from(schema.profileSnapshots)
        .where(eq(schema.profileSnapshots.userId, userId))
        .orderBy(asc(schema.profileSnapshots.version))
        .all()
        .map((r) => JSON.parse(r.data) as UserProfile);
    },

    listUserIds() {
      return db
        .select({ userId: schema.profiles.userId })
        .from(schema.profiles)
        .all()
        .map((r) => r.userId);
    },

    createAccount(account) {
      db.insert(schema.accounts).values(account).run();
    },

    getAccountByEmail(email) {
      const rows = db.select().from(schema.accounts).where(eq(schema.accounts.email, email)).all();
      return rows[0] ?? null;
    },

    getAccountById(userId) {
      const rows = db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)).all();
      return rows[0] ?? null;
    },

    updateAccountDisplayName(userId, displayName) {
      db.update(schema.accounts)
        .set({ displayName })
        .where(eq(schema.accounts.userId, userId))
        .run();
    },

    createAuthSession(session) {
      db.insert(schema.authSessions).values(session).run();
    },

    getAuthSession(tokenHash) {
      const rows = db
        .select()
        .from(schema.authSessions)
        .where(eq(schema.authSessions.tokenHash, tokenHash))
        .all();
      return rows[0] ?? null;
    },

    deleteAuthSession(tokenHash) {
      db.delete(schema.authSessions).where(eq(schema.authSessions.tokenHash, tokenHash)).run();
    },

    getKnowledgeItem(userId, item) {
      const rows = db
        .select()
        .from(schema.knowledgeItems)
        .where(and(eq(schema.knowledgeItems.userId, userId), eq(schema.knowledgeItems.item, item)))
        .all();
      return rows[0] ? parseKnowledgeRow(rows[0]) : null;
    },

    upsertKnowledgeItem(userId, item, updatedAt) {
      const values = {
        userId,
        item: item.item,
        itemType: item.item_type,
        state: item.state,
        lookupCount: item.lookup_count,
        exposureCount: item.exposure_count,
        firstSeen: item.first_seen,
        lastSeen: item.last_seen,
        lastLookupTs: item.last_lookup_ts,
        lastLookupSession: item.last_lookup_session,
        nextReview: item.next_review,
        note: item.note,
        sampleContexts: JSON.stringify(item.sample_contexts),
        updatedAt,
      };
      db.insert(schema.knowledgeItems)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.knowledgeItems.userId, schema.knowledgeItems.item],
          set: values,
        })
        .run();
    },

    listKnowledgeItems(userId) {
      return db
        .select()
        .from(schema.knowledgeItems)
        .where(eq(schema.knowledgeItems.userId, userId))
        .orderBy(asc(schema.knowledgeItems.item))
        .all()
        .map(parseKnowledgeRow);
    },

    insertKnowledgeChange(change) {
      db.insert(schema.knowledgeChanges)
        .values({
          userId: change.user_id,
          sessionId: change.session_id,
          item: change.item,
          fromState: change.from_state,
          toState: change.to_state,
          trigger: change.trigger,
          note: change.note,
          ts: change.ts,
          createdAt: now(),
        })
        .run();
    },

    listKnowledgeChanges(userId, item) {
      const cond = item
        ? and(eq(schema.knowledgeChanges.userId, userId), eq(schema.knowledgeChanges.item, item))
        : eq(schema.knowledgeChanges.userId, userId);
      return db
        .select()
        .from(schema.knowledgeChanges)
        .where(cond)
        .orderBy(asc(schema.knowledgeChanges.ts), asc(schema.knowledgeChanges.id))
        .all()
        .map((r) => ({
          user_id: r.userId,
          session_id: r.sessionId,
          item: r.item,
          from_state: r.fromState as KnowledgeChange["from_state"],
          to_state: r.toState as KnowledgeChange["to_state"],
          trigger: r.trigger as KnowledgeChange["trigger"],
          note: r.note,
          ts: r.ts,
        }));
    },

    saveMaterial(userId, meta) {
      db.insert(schema.materials)
        .values({
          userId,
          materialId: meta.material_id,
          data: JSON.stringify(meta),
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [schema.materials.userId, schema.materials.materialId],
          set: { data: JSON.stringify(meta) },
        })
        .run();
    },

    getMaterial(userId, materialId) {
      const rows = db
        .select()
        .from(schema.materials)
        .where(and(eq(schema.materials.userId, userId), eq(schema.materials.materialId, materialId)))
        .all();
      return rows[0] ? (JSON.parse(rows[0].data) as MaterialMeta) : null;
    },

    insertJournal(entry) {
      db.insert(schema.updateJournal)
        .values({
          userId: entry.userId,
          scale: entry.scale,
          promptVersion: entry.promptVersion,
          model: entry.model,
          inputSummary: entry.inputSummary,
          rawResponse: entry.rawResponse,
          delta: JSON.stringify(entry.delta),
          usage: entry.usage ? JSON.stringify(entry.usage) : null,
          createdAt: entry.createdAt,
        })
        .run();
    },

    listJournal(userId) {
      return db
        .select()
        .from(schema.updateJournal)
        .where(eq(schema.updateJournal.userId, userId))
        .orderBy(asc(schema.updateJournal.id))
        .all()
        .map((r) => ({
          id: r.id,
          userId: r.userId,
          scale: r.scale,
          promptVersion: r.promptVersion,
          model: r.model,
          inputSummary: r.inputSummary,
          rawResponse: r.rawResponse,
          delta: JSON.parse(r.delta) as Record<string, unknown>,
          usage: r.usage ? (JSON.parse(r.usage) as JournalEntry["usage"]) : null,
          createdAt: r.createdAt,
        }));
    },

    // 仅清空词汇账本(知识点 + 变更记录),不动事件/档案/材料/日志
    clearKnowledge(userId) {
      tx(() => {
        db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.userId, userId)).run();
        db.delete(schema.knowledgeChanges).where(eq(schema.knowledgeChanges.userId, userId)).run();
      });
    },

    wipeUser(userId) {
      tx(() => {
        db.delete(schema.events).where(eq(schema.events.userId, userId)).run();
        db.delete(schema.profiles).where(eq(schema.profiles.userId, userId)).run();
        db.delete(schema.profileSnapshots).where(eq(schema.profileSnapshots.userId, userId)).run();
        db.delete(schema.knowledgeItems).where(eq(schema.knowledgeItems.userId, userId)).run();
        db.delete(schema.knowledgeChanges).where(eq(schema.knowledgeChanges.userId, userId)).run();
        db.delete(schema.materials).where(eq(schema.materials.userId, userId)).run();
        db.delete(schema.updateJournal).where(eq(schema.updateJournal.userId, userId)).run();
        db.delete(schema.authSessions).where(eq(schema.authSessions.userId, userId)).run();
        db.delete(schema.accounts).where(eq(schema.accounts.userId, userId)).run();
      });
    },
  };
}

// Next.js 服务端单例（HMR 安全）
const globalStore = globalThis as unknown as { __engineStorage?: Map<string, Storage> };

export function getDefaultStorage(dbPath: string = DEFAULT_DB_PATH): Storage {
  globalStore.__engineStorage ??= new Map();
  let s = globalStore.__engineStorage.get(dbPath);
  if (!s) {
    s = createStorage(dbPath);
    globalStore.__engineStorage.set(dbPath, s);
  }
  return s;
}
