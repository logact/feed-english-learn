import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";
import { getCurrentAccount } from "@/lib/session";
import { createChildLogger } from "@/lib/logger";

// 材料生成引擎：按需生成一篇新材料（同步；agentic loop 可能含多轮 LLM 调用）
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const log = createChildLogger("http");
  const { id } = await params;
  const account = await getCurrentAccount();
  if (!account) {
    log.warn({ route: "/api/users/[id]/materials", status: 401 }, "unauthorized");
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  if (account.userId !== id) {
    log.warn({ route: "/api/users/[id]/materials", userId: account.userId, status: 403 }, "user mismatch");
    return NextResponse.json({ error: "无权访问该用户" }, { status: 403 });
  }
  const reqLog = log.child({ route: "/api/users/[id]/materials", userId: account.userId });

  reqLog.info("request start");
  try {
    const engine = createEngine();
    const material = await engine.generateMaterial(id);
    reqLog.info({ status: 200, materialId: material.material.material_id, turns: material.turns }, "request end");
    return NextResponse.json(material);
  } catch (e) {
    reqLog.error({ status: 500, error: e instanceof Error ? e.message : String(e) }, "request failed");
    throw e;
  }
}
