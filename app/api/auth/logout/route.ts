import { NextRequest, NextResponse, connection } from "next/server";
import { deleteSessionForToken } from "@/lib/auth";
import { getDefaultStorage } from "@/lib/engine/storage";
import { clearSessionCookie, getSessionToken } from "@/lib/session";

export async function POST(request: NextRequest) {
  await connection();
  const storage = getDefaultStorage();
  deleteSessionForToken(storage, await getSessionToken());
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", request.url), 303);
}
