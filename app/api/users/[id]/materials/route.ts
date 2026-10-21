import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";

// 材料生成引擎：按需生成一篇新材料（同步；agentic loop 可能含多轮 LLM 调用）
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const engine = createEngine();
  const material = await engine.generateMaterial(id);
  return NextResponse.json(material);
}
