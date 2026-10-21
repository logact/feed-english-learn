import { NextRequest, NextResponse, connection } from "next/server";
import { z } from "zod";
import { loginWithEmail } from "@/lib/auth";
import { getDefaultStorage } from "@/lib/engine/storage";
import { setSessionCookie } from "@/lib/session";

const LoginSchema = z.object({
  email: z.string().trim().max(254).pipe(z.email({ error: "请输入合法的邮箱地址" })),
});

export async function POST(request: NextRequest) {
  await connection();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "请输入合法的邮箱地址" }, { status: 400 });
  }

  const storage = getDefaultStorage();
  const result = loginWithEmail(storage, parsed.data.email);
  await setSessionCookie(result.token, result.expiresAt);

  return NextResponse.json({
    userId: result.account.userId,
    needsOnboarding: result.needsOnboarding,
  });
}
