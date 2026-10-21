import Link from "next/link";
import { connection } from "next/server";
import { getDefaultStorage } from "@/lib/engine/storage";

// 调试页总是阻塞式按请求渲染（cacheComponents 模式下禁用即时 prerender）
export const instant = false;

export default async function DebugIndex() {
  await connection(); // better-sqlite3 同步驱动：声明按请求读取
  const storage = getDefaultStorage();
  const userIds = storage.listUserIds();
  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>Engine Debug — users</h1>
      {userIds.length === 0 ? (
        <p>No users yet. POST events to /api/events first.</p>
      ) : (
        <ul>
          {userIds.map((id) => (
            <li key={id}>
              <Link href={`/debug/${id}`}>{id}</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
