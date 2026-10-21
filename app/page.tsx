import Link from "next/link";
import { connection } from "next/server";
import { getDefaultStorage } from "@/lib/engine/storage";
import { defaultProfile } from "@/contracts/profile";
import styles from "./page.module.css";

// 首页按请求读取本地 SQLite(cacheComponents 模式下禁用即时 prerender)
export const instant = false;

function Intro() {
  return (
    <main className={`container ${styles.page}`}>
      <section className={styles.hero}>
        <span className="badge">可理解输入 · N+1</span>
        <h1 className={styles.heroTitle}>
          在能读懂的英文里,
          <br />
          自然地遇见下一个新词。
        </h1>
        <p className={styles.heroText}>
          悦读英语会持续追踪你的阅读水平与兴趣,为你生成难度恰好「N+1」的英文短文。
          阅读时点一点生词即可记录,每一次阅读都在悄悄更新你的专属学习档案。
        </p>
        <Link className="btn btn-primary" href="/onboarding">
          开始我的阅读之旅
        </Link>
      </section>
    </main>
  );
}

export default async function Home() {
  await connection(); // better-sqlite3 同步驱动:声明按请求读取
  const storage = getDefaultStorage();
  const userIds = storage.listUserIds();
  if (userIds.length === 0) return <Intro />;

  const userId = userIds[0];
  const profile =
    storage.getProfile(userId) ?? defaultProfile(userId, new Date().toISOString());
  const rs = profile.reading_state;
  const interests = [...profile.interests].sort((a, b) => b.weight - a.weight);

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.dashHeader}>
        <div>
          <p className="faint">欢迎回来</p>
          <h1 className={styles.dashTitle}>{profile.user_id}</h1>
        </div>
        <span className={styles.bandBadge}>{rs.band}</span>
      </header>

      <section className={`card ${styles.statsCard}`}>
        <div className={styles.statGrid}>
          <div className={styles.stat}>
            <span className={styles.statValue}>{rs.vocab_estimate.toLocaleString()}</span>
            <span className={styles.statLabel}>词汇量估计</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>{rs.reading_speed_wpm}</span>
            <span className={styles.statLabel}>阅读速度 (wpm)</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statValue}>
              {(rs.target_lookup_rate[0] * 100).toFixed(0)}–
              {(rs.target_lookup_rate[1] * 100).toFixed(0)}%
            </span>
            <span className={styles.statLabel}>目标查词率</span>
          </div>
        </div>
        <div className={styles.confidenceRow}>
          <span className={styles.statLabel}>信心度</span>
          <div className={styles.confidenceBar}>
            <div
              className={styles.confidenceFill}
              style={{ width: `${Math.round(rs.confidence * 100)}%` }}
            />
          </div>
          <span className={styles.statLabel}>{Math.round(rs.confidence * 100)}%</span>
        </div>
      </section>

      {interests.length > 0 && (
        <section className={styles.interests}>
          <h2 className={styles.sectionTitle}>你的兴趣</h2>
          <div className={styles.chipRow}>
            {interests.map((it) => (
              <span key={it.topic} className="chip">
                {it.topic}
              </span>
            ))}
          </div>
        </section>
      )}

      {profile.notes && (
        <blockquote className={styles.notes}>“{profile.notes}”</blockquote>
      )}

      <div className={styles.actions}>
        <Link className="btn btn-primary" href={`/read/${profile.user_id}`}>
          开始今日阅读
        </Link>
        <Link className="btn btn-ghost" href={`/profile/${profile.user_id}`}>
          查看完整档案
        </Link>
        <Link className="btn btn-ghost" href={`/reassess/${profile.user_id}`}>
          重新测评
        </Link>
      </div>

      {userIds.length > 1 && (
        <p className={`faint ${styles.switcher}`}>
          其他学习者:
          {userIds.map((id) => (
            <Link key={id} className={styles.switchLink} href={`/read/${id}`}>
              {id}
            </Link>
          ))}
        </p>
      )}
    </main>
  );
}
