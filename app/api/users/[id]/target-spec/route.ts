import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";
import { getCurrentAccount } from "@/lib/session";

// 生成引擎消费接口：分层状态 → 材料生成约束
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const account = await getCurrentAccount();
  if (!account) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  if (account.userId !== id) {
    return NextResponse.json({ error: "无权访问该用户" }, { status: 403 });
  }

  const engine = createEngine();
  return NextResponse.json(engine.getTargetSpec(id));
}
