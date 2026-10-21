import Link from "next/link";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import { getCurrentAccount } from "@/lib/session";
import { effectiveState } from "@/lib/engine/knowledge";
import { KNOWLEDGE_STATES, type KnowledgeState } from "@/contracts/knowledge";
import styles from "./page.module.css";

// 档案页按请求读取本地 SQLite(cacheComponents 模式下禁用即时 prerender)
export const instant = false;

const STATE_LABEL: Record<KnowledgeState, string> = {
  new: "初遇",
  supported: "有支撑",
  familiar: "熟悉",
  mastered: "已掌握",
  fading: "消退中",
};

const PREVIEW_COUNT = 10;

export default async function ProfilePage({ params }: PageProps<"/profile/[userId]">) {
  await connection(); // better-sqlite3 同步驱动:声明按请求读取
  const { userId } = await params;
  const storage = getDefaultStorage();
  const account = await getCurrentAccount(storage);
  if (!account) redirect("/login");
  if (account.userId !== userId) notFound();

  const profile = storage.getProfile(userId);
  if (!profile) notFound();

  const now = storage.lastEventTs(userId) ?? new Date().toISOString();
  const items = storage
    .listKnowledgeItems(userId)
    .map((it) => ({ ...it, effective_state: effectiveState(it, now) as KnowledgeState }));

  const byState = new Map<KnowledgeState, typeof items>();
  for (const s of KNOWLEDGE_STATES) byState.set(s, []);
  for (const it of items) byState.get(it.effective_state)!.push(it);

  const rs = profile.reading_state;
  const interests = [...profile.interests].sort((a, b) => b.weight - a.weight);

  const fields: [string, React.ReactNode][] = [
    ["当前水平 (band)", <span key="band" className="badge">{rs.band}</span>],
    ["词汇量估计", rs.vocab_estimate.toLocaleString()],
    ["信心度", `${Math.round(rs.confidence * 100)}%`],
    [
      "目标查词率",
      `${(rs.target_lookup_rate[0] * 100).toFixed(1)}% – ${(rs.target_lookup_rate[1] * 100).toFixed(1)}%`,
    ],
    ["舒适篇幅", `${rs.comfortable_length_words} 词`],
    ["最长篇幅", `${rs.max_length_words} 词`],
    ["阅读速度", `${rs.reading_speed_wpm} 词/分钟`],
    ["距上次阶段检查", `${rs.sessions_since_review} 个 session`],
  ];

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.header}>
        <div>
          <p className="faint">个人档案 · {account.email}</p>
          <h1 className={styles.title}>{account.displayName ?? account.email}</h1>
        </div>
        <span className={styles.bandBadge}>{rs.band}</span>
      </header>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>阅读状态</h2>
        <dl className={styles.dl}>
          {fields.map(([label, value]) => (
            <div key={label} className={styles.dlRow}>
              <dt className={styles.dt}>{label}</dt>
              <dd className={styles.dd}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className={styles.evidence}>
          <h3 className={styles.subTitle}>判断依据</h3>
          <p className="muted">{rs.evidence}</p>
        </div>
      </section>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>兴趣</h2>
        {interests.length === 0 ? (
          <p className="faint">还没有记录到兴趣。</p>
        ) : (
          <ul className={styles.interestList}>
            {interests.map((it) => (
              <li key={it.topic} className={styles.interestRow}>
                <span className={styles.interestTopic}>{it.topic}</span>
                <div className={styles.weightBar}>
                  <div
                    className={styles.weightFill}
                    style={{ width: `${Math.round(it.weight * 100)}%` }}
                  />
                </div>
                <span className="faint">{it.weight.toFixed(2)}</span>
                {it.note && <span className={`faint ${styles.interestNote}`}>{it.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={`card ${styles.section}`}>
        <h2 className={styles.sectionTitle}>词汇账本</h2>
        {items.length === 0 ? (
          <p className="faint">还没有词汇记录,去读一篇吧。</p>
        ) : (
          <div className={styles.stateGrid}>
            {KNOWLEDGE_STATES.map((s) => {
              const list = byState.get(s) ?? [];
              return (
                <div key={s} className={styles.stateBlock}>
                  <p className={styles.stateHead}>
                    {STATE_LABEL[s]} <span className="faint">({list.length})</span>
                  </p>
                  <p className={styles.stateWords}>
                    {list.slice(0, PREVIEW_COUNT).map((it) => it.item).join("、") || "—"}
                    {list.length > PREVIEW_COUNT ? ` 等 ${list.length} 个` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {profile.notes && (
        <section className={`card ${styles.section}`}>
          <h2 className={styles.sectionTitle}>学习笔记</h2>
          <p className={styles.notes}>{profile.notes}</p>
        </section>
      )}

      <p className="faint">
        档案版本 v{profile.version} · 更新于 {new Date(profile.updated_at).toLocaleString("zh-CN")}
      </p>

      <div className={styles.links}>
        <Link className="btn btn-primary" href={`/read/${profile.user_id}`}>
          去阅读
        </Link>
        <Link className="btn btn-ghost" href={`/reassess/${profile.user_id}`}>
          重新测评
        </Link>
        <Link className="btn btn-ghost" href="/">
          返回首页
        </Link>
        <Link className={styles.debugLink} href={`/debug/${profile.user_id}`}>
          调试视图
        </Link>
      </div>
    </main>
  );
}
