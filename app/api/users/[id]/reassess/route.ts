import { NextRequest, NextResponse, connection } from "next/server";
import { z } from "zod";
import { BandSchema, defaultProfile } from "@/contracts/profile";
import { getDefaultStorage } from "@/lib/engine/storage";
import { BAND_VOCAB } from "@/lib/band-vocab";

// 重新测评:自评重置 reading_state,可选清空词汇账本
// body: { band, interests?(≤12), reset_knowledge?(默认 false) }
const ReassessSchema = z.object({
  band: BandSchema,
  interests: z.array(z.string().min(1).max(40)).max(12).optional(),
  reset_knowledge: z.boolean().default(false),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = ReassessSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "参数不合法", details: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }
  const { band, interests, reset_knowledge } = parsed.data;

  const storage = getDefaultStorage();
  const current = storage.getProfile(id);
  if (!current) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const oldBand = current.reading_state.band;
  const profile = {
    ...current,
    version: current.version + 1,
    updated_at: now,
    reading_state: {
      ...defaultProfile(id, now).reading_state,
      band,
      vocab_estimate: BAND_VOCAB[band],
      confidence: 0.3,
      evidence: `reassess 自评 band=${band},从 band=${oldBand} 重置`,
    },
    interests: interests
      ? interests.map((topic, i) => ({
          topic,
          weight: Math.max(0.4, Math.round((1 - i * 0.15) * 100) / 100),
          note: "reassess 自选",
        }))
      : current.interests,
    notes:
      `${current.notes}${current.notes ? "\n" : ""}` +
      `[reassess] ${now.slice(0, 10)} 自评 band=${band}(原 ${oldBand})`,
  };

  if (reset_knowledge) storage.clearKnowledge(id);
  storage.saveProfile(profile); // 同时写入 snapshot 历史

  return NextResponse.json(profile);
}
