import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import ReassessForm from "./reassess-form";

// 重新测评页按请求读取档案(cacheComponents 模式下禁用即时 prerender)
export const instant = false;

export default async function ReassessPage({ params }: PageProps<"/reassess/[userId]">) {
  await connection(); // better-sqlite3 同步驱动:声明按请求读取
  const { userId } = await params;
  const storage = getDefaultStorage();
  const profile = storage.getProfile(userId);
  if (!profile) notFound();
  return (
    <ReassessForm
      userId={userId}
      currentBand={profile.reading_state.band}
      currentInterests={profile.interests.map((it) => it.topic)}
    />
  );
}
