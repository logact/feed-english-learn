import { NextRequest, NextResponse, connection } from "next/server";
import { createEngine } from "@/lib/engine/engine";
import { TokenQuotaExceededError } from "@/lib/engine/quota";
import { getCurrentAccount } from "@/lib/session";
import { createChildLogger } from "@/lib/logger";
import { acquireGenerationLock, checkGenerationQuota } from "@/lib/generation-guard";
import { getDefaultStorage } from "@/lib/engine/storage";

// 材料生成引擎：按需生成一篇新材料（同步；agentic loop 可能含多轮 LLM 调用）
// 成本守卫：同用户并发互斥（409）+ 冷却期/每日配额（429），防止接口被反复触发
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
  const release = acquireGenerationLock(id);
  if (!release) {
    reqLog.warn({ status: 409 }, "generation already in flight");
    return NextResponse.json({ error: "上一篇材料还在生成中，请稍候" }, { status: 409 });
  }
  try {
    const verdict = checkGenerationQuota(getDefaultStorage(), id);
    if (!verdict.ok) {
      const error =
        verdict.reason === "cooldown"
          ? `生成太频繁了，请 ${verdict.retryAfterSeconds} 秒后再试`
          : "今日生成次数已达上限，请明天再来";
      reqLog.warn({ status: 429, reason: verdict.reason, retryAfterSeconds: verdict.retryAfterSeconds }, "generation quota rejected");
      return NextResponse.json(
        { error, retryAfterSeconds: verdict.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
      );
    }

    const engine = createEngine();
    const material = await engine.generateMaterial(id);
    reqLog.info({ status: 200, materialId: material.material.material_id, turns: material.turns }, "request end");
    return NextResponse.json(material);
  } catch (e) {
    if (e instanceof TokenQuotaExceededError) {
      reqLog.warn({ status: 429, reason: "token_quota" }, "token quota exceeded");
      return NextResponse.json({ error: "今日生成额度已用完,明天再来吧" }, { status: 429 });
    }
    reqLog.error({ status: 500, error: e instanceof Error ? e.message : String(e) }, "request failed");
    throw e;
  } finally {
    release();
  }
}
