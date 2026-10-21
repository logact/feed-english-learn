import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Account, Storage } from "./engine/storage";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface LoginResult {
  account: Account;
  token: string;
  expiresAt: string;
  needsOnboarding: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function loginWithEmail(
  storage: Storage,
  email: string,
  now: Date = new Date(),
): LoginResult {
  const normalizedEmail = normalizeEmail(email);
  let account = storage.getAccountByEmail(normalizedEmail);
  const createdAt = now.toISOString();

  if (!account) {
    account = {
      userId: `reader-${randomUUID()}`,
      email: normalizedEmail,
      displayName: null,
      createdAt,
    };
    storage.createAccount(account);
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  storage.createAuthSession({
    tokenHash: hashSessionToken(token),
    userId: account.userId,
    expiresAt,
    createdAt,
  });

  return {
    account,
    token,
    expiresAt,
    needsOnboarding: storage.getProfile(account.userId) === null,
  };
}

export function getAccountForSessionToken(
  storage: Storage,
  token: string | undefined,
  now: Date = new Date(),
): Account | null {
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const session = storage.getAuthSession(tokenHash);
  if (!session) return null;

  if (session.expiresAt <= now.toISOString()) {
    storage.deleteAuthSession(tokenHash);
    return null;
  }

  return storage.getAccountById(session.userId);
}

export function deleteSessionForToken(storage: Storage, token: string | undefined): void {
  if (token) storage.deleteAuthSession(hashSessionToken(token));
}
