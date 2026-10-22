import { cookies } from "next/headers";
import { connection, type NextRequest } from "next/server";
import { getAccountForSessionToken, SESSION_TTL_SECONDS } from "./auth";
import { getDefaultStorage, type Account, type Storage } from "./engine/storage";

export const SESSION_COOKIE = "reader_session";

export function isSecureRequest(request: NextRequest): boolean {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (forwardedProtocol) return forwardedProtocol === "https";
  return request.nextUrl.protocol === "https:";
}

export async function getSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

export async function getCurrentAccount(
  storage: Storage = getDefaultStorage(),
): Promise<Account | null> {
  await connection();
  const token = await getSessionToken();
  return getAccountForSessionToken(storage, token);
}

export async function setSessionCookie(
  token: string,
  expiresAt: string,
  secure: boolean,
): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: new Date(expiresAt),
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
