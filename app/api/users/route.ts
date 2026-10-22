import { NextRequest, NextResponse, connection } from "next/server";
import { z } from "zod";
import { BANDS, defaultProfile } from "@/contracts/profile";
import { getDefaultStorage } from "@/lib/engine/storage";
import { BAND_VOCAB } from "@/lib/band-vocab";
import { getCurrentAccount } from "@/lib/session";

// 新手引导建档:body { nickname, band, interests }
const CreateUserSchema = z.object({
  nickname: z.string().trim().min(1).max(40),
  band: z.enum(BANDS),
  interests: z.array(z.string().min(1).max(40)).max(12).default([]),
});

export async function POST(request: NextRequest) {
  await connection();
  const storage = getDefaultStorage();
  const account = await getCurrentAccount(storage);
  if (!account) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  if (storage.getProfile(account.userId)) {
    return NextResponse.json({ error: "当前账号已完成建档" }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = CreateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "参数不合法", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }
  const { nickname, band, interests } = parsed.data;

  const now = new Date().toISOString();
  const profile = defaultProfile(account.userId, now);
  profile.reading_state.band = band;
  profile.reading_state.vocab_estimate = BAND_VOCAB[band];
  profile.reading_state.confidence = 0.3;
  profile.reading_state.evidence = `onboarding 自评 band=${band},词汇量按档位初始化为 ${BAND_VOCAB[band]}`;
  profile.interests = interests.map((topic, i) => ({
    topic,
    weight: Math.max(0.4, Math.round((1 - i * 0.15) * 100) / 100),
    note: "onboarding 自选",
  }));
  // 建档 + 昵称原子提交：避免 profile 已建而昵称丢失后重试撞 409
  storage.transaction(() => {
    storage.saveProfile(profile);
    storage.updateAccountDisplayName(account.userId, nickname);
  });
  return NextResponse.json(profile, { status: 201 });
}
