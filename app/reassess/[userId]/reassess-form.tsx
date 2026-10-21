"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

export default function ReassessForm({
  userId,
  currentBand,
  currentInterests,
}: {
  userId: string;
  currentBand: Band;
  currentInterests: string[];
}) {
  const router = useRouter();
  const [band, setBand] = useState<Band>(currentBand);
  const [selected, setSelected] = useState<string[]>(currentInterests);
  const [custom, setCustom] = useState("");
  const [resetKnowledge, setResetKnowledge] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleInterest = (topic: string) => {
    setSelected((prev) =>
      prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic],
    );
  };

  const addCustom = () => {
    const t = custom.trim();
    if (t && !selected.includes(t) && selected.length < 12) {
      setSelected((prev) => [...prev, t]);
    }
    setCustom("");
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/reassess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          band,
          interests: selected,
          reset_knowledge: resetKnowledge,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "保存失败,请稍后再试");
        setSubmitting(false);
        return;
      }
      router.push("/");
    } catch {
      setError("网络异常,请稍后再试");
      setSubmitting(false);
    }
  }

  const customSelected = selected.filter((t) => !PRESET_INTERESTS.includes(t));

  return (
    <main className={`container ${styles.page}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>重新测评</h1>
        <p className="muted">
          感觉最近的材料太简单或太吃力?重新自评一次,引擎会按新水平重新为你生成材料。
        </p>
      </header>

      <form className={styles.form} onSubmit={handleSubmit}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>1 · 你觉得自己目前的英语水平?</h2>
          <div className={styles.bandGrid}>
            {BANDS.map((b) => (
              <button
                key={b}
                type="button"
                className={`${styles.bandCard} ${band === b ? styles.bandCardActive : ""}`}
                onClick={() => setBand(b)}
              >
                <span className={styles.bandName}>
                  {b}
                  {b === currentBand && <span className={styles.currentTag}>当前</span>}
                </span>
                <span className={styles.bandDesc}>{BAND_DESC[b]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>2 · 想读些什么?(可多选)</h2>
          <div className={styles.chipRow}>
            {PRESET_INTERESTS.map((t) => (
              <button
                key={t}
                type="button"
                className={`${styles.chipBtn} ${selected.includes(t) ? styles.chipBtnActive : ""}`}
                onClick={() => toggleInterest(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className={styles.customRow}>
            <input
              className={styles.input}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
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
          {customSelected.length > 0 && (
            <div className={styles.chipRow}>
              {customSelected.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`${styles.chipBtn} ${styles.chipBtnActive}`}
                  onClick={() => toggleInterest(t)}
                >
                  {t} ×
                </button>
              ))}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={resetKnowledge}
              onChange={(e) => setResetKnowledge(e.target.checked)}
            />
            <span>
              同时清空词汇记录(测试用,不可恢复)
              <span className={`faint ${styles.checkboxHint}`}>
                清空后引擎将不认识任何词,适合从头验证学习闭环
              </span>
            </span>
          </label>
        </section>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? "正在重置档案…" : "确认重置"}
          </button>
          <Link className="btn btn-ghost" href="/">
            取消
          </Link>
        </div>
      </form>
    </main>
  );
}
