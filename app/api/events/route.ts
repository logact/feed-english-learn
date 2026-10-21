import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";
import { getCurrentAccount } from "@/lib/session";

// 事件摄入：body 为单个事件或事件数组
export async function POST(request: NextRequest) {
  await connection();
  const account = await getCurrentAccount();
  if (!account) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const events = Array.isArray(body) ? body : [body];
  const belongsToAccount = events.every(
    (event) =>
      typeof event === "object" &&
      event !== null &&
      "user_id" in event &&
      event.user_id === account.userId,
  );
  if (!belongsToAccount) {
    return NextResponse.json({ error: "事件必须属于当前登录用户" }, { status: 403 });
  }

  const engine = createEngine();
  const result = await engine.processEvents(body);
  const status = result.processed === 0 && result.errors.length > 0 ? 400 : 200;
  return NextResponse.json(result, { status });
}
