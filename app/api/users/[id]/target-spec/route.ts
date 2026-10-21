import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";

// 生成引擎消费接口：分层状态 → 材料生成约束
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const engine = createEngine();
  return NextResponse.json(engine.getTargetSpec(id));
}
