import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";
import { TokenQuotaExceededError } from "@/lib/engine/quota";
import { getCurrentAccount } from "@/lib/session";
import { acquireGenerationLock, checkGenerationQuota } from "@/lib/generation-guard";
import { getDefaultStorage } from "@/lib/engine/storage";

// 材料生成引擎：按需生成一篇新材料（同步；agentic loop 可能含多轮 LLM 调用）
// 成本守卫：同用户并发互斥（409）+ 冷却期/每日配额（429），防止接口被反复触发
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const account = await getCurrentAccount();
  if (!account) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  if (account.userId !== id) {
    return NextResponse.json({ error: "无权访问该用户" }, { status: 403 });
  }

  const release = acquireGenerationLock(id);
  if (!release) {
    return NextResponse.json({ error: "上一篇材料还在生成中，请稍候" }, { status: 409 });
  }
  try {
    const verdict = checkGenerationQuota(getDefaultStorage(), id);
    if (!verdict.ok) {
      const error =
        verdict.reason === "cooldown"
          ? `生成太频繁了，请 ${verdict.retryAfterSeconds} 秒后再试`
          : "今日生成次数已达上限，请明天再来";
      return NextResponse.json(
        { error, retryAfterSeconds: verdict.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
      );
    }

    const engine = createEngine();
    const material = await engine.generateMaterial(id);
    return NextResponse.json(material);
  } catch (e) {
    if (e instanceof TokenQuotaExceededError) {
      return NextResponse.json({ error: "今日生成额度已用完,明天再来吧" }, { status: 429 });
    }
    throw e;
  } finally {
    release();
  }
}
