import Link from "next/link";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import { getCurrentAccount } from "@/lib/session";

// 调试页总是阻塞式按请求渲染（cacheComponents 模式下禁用即时 prerender）
export const instant = false;

export default async function DebugIndex() {
  await connection(); // better-sqlite3 同步驱动：声明按请求读取
  const storage = getDefaultStorage();
  const account = await getCurrentAccount(storage);
  if (!account) redirect("/login");

  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>Engine Debug</h1>
      <p>{account.email}</p>
      <Link href={`/debug/${account.userId}`}>查看当前账号的学习数据</Link>
    </main>
  );
}
