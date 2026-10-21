import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteSessionForToken,
  getAccountForSessionToken,
  hashSessionToken,
  loginWithEmail,
  normalizeEmail,
  SESSION_TTL_SECONDS,
} from "../lib/auth";
import { defaultProfile } from "../contracts/profile";
import { createStorage, type Storage } from "../lib/engine/storage";

let storage: Storage;

beforeEach(() => {
  storage = createStorage(":memory:");
});

afterEach(() => {
  storage.close();
});

describe("邮箱账号", () => {
  it("统一去除首尾空白并转为小写", () => {
    expect(normalizeEmail("  Reader@Example.COM \n")).toBe("reader@example.com");
  });

  it("同一邮箱复用账号，不同邮箱创建不同账号", () => {
    const first = loginWithEmail(storage, "reader@example.com");
    const same = loginWithEmail(storage, " Reader@Example.com ");
    const other = loginWithEmail(storage, "other@example.com");

    expect(same.account.userId).toBe(first.account.userId);
    expect(other.account.userId).not.toBe(first.account.userId);
    expect(same.token).not.toBe(first.token);
  });

  it("已有学习档案的账号无需重复 onboarding", () => {
    const first = loginWithEmail(storage, "reader@example.com");
    expect(first.needsOnboarding).toBe(true);

    storage.saveProfile(defaultProfile(first.account.userId, new Date().toISOString()));
    storage.updateAccountDisplayName(first.account.userId, "读者");
    const returning = loginWithEmail(storage, "reader@example.com");

    expect(returning.needsOnboarding).toBe(false);
    expect(returning.account.displayName).toBe("读者");
  });
});

describe("数据库会话", () => {
  it("有效 token 恢复账号，过期后删除会话", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const login = loginWithEmail(storage, "reader@example.com", now);

    expect(
      getAccountForSessionToken(
        storage,
        login.token,
        new Date(now.getTime() + SESSION_TTL_SECONDS * 1000 - 1),
      )?.userId,
    ).toBe(login.account.userId);

    expect(
      getAccountForSessionToken(
        storage,
        login.token,
        new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
      ),
    ).toBeNull();
    expect(storage.getAuthSession(hashSessionToken(login.token))).toBeNull();
  });

  it("退出登录后 token 立即失效", () => {
    const login = loginWithEmail(storage, "reader@example.com");
    deleteSessionForToken(storage, login.token);

    expect(getAccountForSessionToken(storage, login.token)).toBeNull();
    expect(storage.getAuthSession(hashSessionToken(login.token))).toBeNull();
  });

  it("清理用户时同时删除账号和会话", () => {
    const login = loginWithEmail(storage, "reader@example.com");
    storage.wipeUser(login.account.userId);

    expect(storage.getAccountById(login.account.userId)).toBeNull();
    expect(storage.getAuthSession(hashSessionToken(login.token))).toBeNull();
  });
});
