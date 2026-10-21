"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BANDS, type Band } from "@/contracts/profile";
import styles from "./page.module.css";

const BAND_DESC: Record<Band, string> = {
  A1: "刚起步,能读懂最简单的短句",
  A2: "能读懂日常话题的简单短文",
  B1: "能读懂熟悉话题的中等篇幅文章",
  B2: "能较流畅地读懂新闻与通俗文章",
  C1: "能读懂长文与较抽象的内容",
  C2: "接近母语者,几乎无障碍",
};

const PRESET_INTERESTS = [
  "科技",
  "旅行",
  "美食",
  "体育",
  "商业",
  "文化",
  "健康",
  "电影",
  "音乐",
  "历史",
];

export default function OnboardingForm({ email }: { email: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [band, setBand] = useState<Band | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleInterest = (topic: string) => {
    setSelected((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic],
    );
  };

  const addCustom = () => {
    const topic = custom.trim();
    if (topic && !selected.includes(topic) && selected.length < 12) {
      setSelected((prev) => [...prev, topic]);
    }
    setCustom("");
  };

  const canSubmit = nickname.trim().length > 0 && band !== null && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !band) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nickname.trim(), band, interests: selected }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "保存失败,请稍后再试");
        setSubmitting(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("网络异常,请稍后再试");
      setSubmitting(false);
    }
  }

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>欢迎来到悦读英语</h1>
        <p className="muted">花一分钟告诉我们你是谁,我们会为你准备恰到好处的第一篇文章。</p>
        <p className="faint">当前账号：{email}</p>
      </header>

      <form className={styles.form} onSubmit={handleSubmit}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>1 · 怎么称呼你?</h2>
          <input
            className={styles.input}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="你的昵称"
            maxLength={40}
          />
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>2 · 你觉得自己目前的英语水平?</h2>
          <div className={styles.bandGrid}>
            {BANDS.map((value) => (
              <button
                key={value}
                type="button"
                className={`${styles.bandCard} ${band === value ? styles.bandCardActive : ""}`}
                onClick={() => setBand(value)}
              >
                <span className={styles.bandName}>{value}</span>
                <span className={styles.bandDesc}>{BAND_DESC[value]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>3 · 想读些什么?(可多选)</h2>
          <div className={styles.chipRow}>
            {PRESET_INTERESTS.map((topic) => (
              <button
                key={topic}
                type="button"
                className={`${styles.chipBtn} ${selected.includes(topic) ? styles.chipBtnActive : ""}`}
                onClick={() => toggleInterest(topic)}
              >
                {topic}
              </button>
            ))}
          </div>
          <div className={styles.customRow}>
            <input
              className={styles.input}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustom();
                }
              }}
              placeholder="自定义兴趣,回车添加"
              maxLength={20}
            />
            <button type="button" className="btn btn-ghost" onClick={addCustom}>
              添加
            </button>
          </div>
          {selected.some((topic) => !PRESET_INTERESTS.includes(topic)) && (
            <div className={styles.chipRow}>
              {selected
                .filter((topic) => !PRESET_INTERESTS.includes(topic))
                .map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    className={`${styles.chipBtn} ${styles.chipBtnActive}`}
                    onClick={() => toggleInterest(topic)}
                  >
                    {topic} ×
                  </button>
                ))}
            </div>
          )}
        </section>

        {error && <p className={styles.error}>{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {submitting ? "正在为你建档…" : "完成,开始阅读"}
        </button>
      </form>
    </main>
  );
}
