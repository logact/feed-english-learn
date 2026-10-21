import { NextRequest, NextResponse } from "next/server";
import { createEngine } from "@/lib/engine/engine";

// 事件摄入：body 为单个事件或事件数组
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const engine = createEngine();
  const result = await engine.processEvents(body);
  const status = result.processed === 0 && result.errors.length > 0 ? 400 : 200;
  return NextResponse.json(result, { status });
}
