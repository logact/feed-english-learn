import Link from "next/link";
import { redirect } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import { getCurrentAccount } from "@/lib/session";
import styles from "./page.module.css";

// 首页按请求读取会话与本地 SQLite(cacheComponents 模式下禁用即时 prerender)
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
        <Link className="btn btn-primary" href="/login">
          邮箱登录，开始阅读
        </Link>
      </section>
    </main>
  );
}

export default async function Home() {
  const storage = getDefaultStorage();
  const account = await getCurrentAccount(storage);
  if (!account) return <Intro />;

  const profile = storage.getProfile(account.userId);
  if (!profile) redirect("/onboarding");

  const rs = profile.reading_state;
  const interests = [...profile.interests].sort((a, b) => b.weight - a.weight);

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.dashHeader}>
        <div>
          <p className="faint">欢迎回来 · {account.email}</p>
          <h1 className={styles.dashTitle}>{account.displayName ?? account.email}</h1>
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
        <form action="/api/auth/logout" method="post">
          <button className="btn btn-quiet" type="submit">
            退出登录
          </button>
        </form>
      </div>
    </main>
  );
}
