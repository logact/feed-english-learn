import { NextRequest, NextResponse, connection } from "next/server";
import { z } from "zod";
import { BANDS, defaultProfile } from "@/contracts/profile";
import { getDefaultStorage } from "@/lib/engine/storage";
import { BAND_VOCAB } from "@/lib/band-vocab";

// 新手引导建档:body { user_id, band, interests }
const CreateUserSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "user_id 需为小写字母/数字/连字符"),
  band: z.enum(BANDS),
  interests: z.array(z.string().min(1).max(40)).max(12).default([]),
});

export async function POST(request: NextRequest) {
  await connection();
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
  const { user_id, band, interests } = parsed.data;

  const storage = getDefaultStorage();
  if (storage.getProfile(user_id)) {
    return NextResponse.json({ error: "这个 ID 已被使用" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const profile = defaultProfile(user_id, now);
  profile.reading_state.band = band;
  profile.reading_state.vocab_estimate = BAND_VOCAB[band];
  profile.reading_state.confidence = 0.3;
  profile.reading_state.evidence = `onboarding 自评 band=${band},词汇量按档位初始化为 ${BAND_VOCAB[band]}`;
  profile.interests = interests.map((topic, i) => ({
    topic,
    weight: Math.max(0.4, Math.round((1 - i * 0.15) * 100) / 100),
    note: "onboarding 自选",
  }));
  storage.saveProfile(profile);

  return NextResponse.json(profile, { status: 201 });
}
