import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage } from "../lib/engine/storage";
import type { MaterialMeta } from "../contracts/events";

function makeMeta(materialId: string, text: string): MaterialMeta {
  return {
    material_id: materialId,
    topics: ["tech"],
    difficulty: "A2",
    length_words: 100,
    summary: text.slice(0, 20),
    text,
  };
}

describe("materials 按用户隔离", () => {
  it("同一 material_id 不同用户互不覆盖", () => {
    const storage = createStorage(":memory:");
    storage.saveMaterial("u1", makeMeta("m1", "victim text"));
    // 攻击者撞键：同 material_id，自己的 userId
    storage.saveMaterial("u2", makeMeta("m1", "attacker text"));

    expect(storage.getMaterial("u1", "m1")?.text).toBe("victim text");
    expect(storage.getMaterial("u2", "m1")?.text).toBe("attacker text");
  });

  it("getMaterial 跨用户读不到", () => {
    const storage = createStorage(":memory:");
    storage.saveMaterial("u1", makeMeta("m1", "private"));
    expect(storage.getMaterial("u2", "m1")).toBeNull();
  });

  it("同用户同 material_id 仍可 upsert 更新", () => {
    const storage = createStorage(":memory:");
    storage.saveMaterial("u1", makeMeta("m1", "v1"));
    storage.saveMaterial("u1", makeMeta("m1", "v2"));
    expect(storage.getMaterial("u1", "m1")?.text).toBe("v2");
  });

  it("wipeUser 只删本人材料", () => {
    const storage = createStorage(":memory:");
    storage.saveMaterial("u1", makeMeta("m1", "mine"));
    storage.saveMaterial("u2", makeMeta("m2", "theirs"));
    storage.wipeUser("u1");
    expect(storage.getMaterial("u1", "m1")).toBeNull();
    expect(storage.getMaterial("u2", "m2")?.text).toBe("theirs");
  });
});

describe("materials 旧表迁移", () => {
  it("无 user_id 的旧表被重建为新结构", () => {
    const dir = mkdtempSync(join(tmpdir(), "materials-mig-"));
    const dbPath = join(dir, "engine.db");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(
        "CREATE TABLE materials (material_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)",
      );
      legacy
        .prepare("INSERT INTO materials VALUES (?, ?, ?)")
        .run("m-old", JSON.stringify(makeMeta("m-old", "stale")), "2026-01-01T00:00:00.000Z");
      legacy.close();

      const storage = createStorage(dbPath);
      // 旧行不可恢复归属，被丢弃；新结构可正常读写
      expect(storage.getMaterial("u1", "m-old")).toBeNull();
      storage.saveMaterial("u1", makeMeta("m1", "fresh"));
      expect(storage.getMaterial("u1", "m1")?.text).toBe("fresh");
      storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
