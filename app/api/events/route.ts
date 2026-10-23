import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";
import { getCurrentAccount } from "@/lib/session";
import { createChildLogger } from "@/lib/logger";

// 事件摄入：body 为单个事件或事件数组
export async function POST(request: NextRequest) {
  await connection();
  const log = createChildLogger("http");
  const account = await getCurrentAccount();
  if (!account) {
    log.warn({ route: "/api/events", status: 401 }, "unauthorized");
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const reqLog = log.child({ route: "/api/events", userId: account.userId });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    reqLog.warn({ status: 400 }, "invalid JSON body");
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
    reqLog.warn({ status: 403 }, "event user mismatch");
    return NextResponse.json({ error: "事件必须属于当前登录用户" }, { status: 403 });
  }

  reqLog.info({ events: events.length }, "request start");
  try {
    const engine = createEngine();
    const result = await engine.processEvents(body);
    // 客户端只看 res.ok：任何失败都必须以非 2xx 暴露；重试靠 event_id 幂等去重保证安全
    const hasProcessingError = result.results.some((r) => r.status === "error");
    const status = hasProcessingError ? 500 : result.errors.length > 0 ? 400 : 200;
    reqLog.info({ status, processed: result.processed, errors: result.errors.length, sessionUpdates: result.sessionUpdates, duplicates: result.duplicates }, "request end");
    return NextResponse.json(result, { status });
  } catch (e) {
    reqLog.error({ status: 500, error: e instanceof Error ? e.message : String(e) }, "request failed");
    throw e;
  }
}
