import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import ReadSession from "./read-session";

// 阅读页按请求校验用户(cacheComponents 模式下禁用即时 prerender)
export const instant = false;

export default async function ReadPage({ params }: PageProps<"/read/[userId]">) {
  await connection(); // better-sqlite3 同步驱动:声明按请求读取
  const { userId } = await params;
  const storage = getDefaultStorage();
  const profile = storage.getProfile(userId);
  if (!profile) notFound();
  return (
    <ReadSession
      userId={userId}
      band={profile.reading_state.band}
      comfortableLength={profile.reading_state.comfortable_length_words}
    />
  );
}
