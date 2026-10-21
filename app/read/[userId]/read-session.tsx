"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { GeneratedMaterial } from "@/contracts/generator";
import styles from "./page.module.css";

type Phase = "idle" | "generating" | "reading" | "closing" | "done" | "error";

interface Selection {
  lemma: string;
  sentence: string;
}

const WORD_RE = /[A-Za-z][A-Za-z'’-]*/;

function toLemma(token: string): string {
  return token.toLowerCase().replace(/^[’']+|[’']+$/g, "");
}

function findSentence(paragraph: string, token: string): string {
  const sentences = paragraph.split(/(?<=[.!?…])\s+/);
  const lower = token.toLowerCase();
  return (
    sentences.find((s) => s.toLowerCase().includes(lower))?.trim() ?? paragraph.slice(0, 300)
  );
}

export default function ReadSession({
  userId,
  band,
  comfortableLength,
}: {
  userId: string;
  band: string;
  comfortableLength: number;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [material, setMaterial] = useState<GeneratedMaterial | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<Map<string, string>>(new Map());
  const [knownMarked, setKnownMarked] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [feedbackSent, setFeedbackSent] = useState<"like" | "dislike" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);

  const now = () => new Date().toISOString();

  // 事件发送失败不阻塞阅读:静默重试一次
  async function sendEvent(ev: Record<string, unknown>, retry = true): Promise<boolean> {
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, session_id: sessionId, ts: now(), ...ev }),
      });
      if (res.ok) return true;
    } catch {
      /* 网络异常时落入重试 */
    }
    if (retry) return sendEvent(ev, false);
    return false;
  }

  async function generate() {
    setPhase("generating");
    setError(null);
    setLookedUp(new Map());
    setKnownMarked(new Set());
    setFeedbackSent(null);
    setSelection(null);
    try {
      const res = await fetch(`/api/users/${userId}/materials`, { method: "POST" });
      if (!res.ok) throw new Error(`生成失败 (${res.status})`);
      const gm = (await res.json()) as GeneratedMaterial;
      const sid = crypto.randomUUID();
      setSessionId(sid);
      setMaterial(gm);
      startedAtRef.current = Date.now();
      // session_start 携带正文,供引擎做曝光记账
      await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          session_id: sid,
          ts: now(),
          type: "session_start",
          material: gm.material,
        }),
      }).catch(() => {});
      setPhase("reading");
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败,请稍后再试");
      setPhase("error");
    }
  }

  function openWord(token: string, paragraph: string) {
    const lemma = toLemma(token);
    if (!lemma || !sessionId) return;
    const sentence = findSentence(paragraph, token);
    setSelection({ lemma, sentence });
    setLookedUp((prev) => new Map(prev).set(lemma, sentence));
    void sendEvent({ type: "word_lookup", lemma, item_type: "word", sentence });
  }

  function markKnown(lemma: string) {
    setKnownMarked((prev) => new Set(prev).add(lemma));
    void sendEvent({ type: "word_known", lemma });
    setSelection(null);
  }

  async function finish(completed: boolean) {
    if (!material || !sessionId) return;
    setPhase("closing");
    const base = {
      material_id: material.material.material_id,
      // 仅在点击事件处理器中执行的计时,非渲染期调用
      // eslint-disable-next-line react-hooks/purity
      duration_ms: Date.now() - startedAtRef.current,
      words_read: material.material.length_words,
    };
    await sendEvent({
      type: completed ? "material_completed" : "material_abandoned",
      completion_rate: completed ? 1 : scrollCompletion(),
      ...base,
    });
    // session_end 会触发档案更新(LLM,可能需要几秒)
    await sendEvent({ type: "session_end" });
    setPhase("done");
  }

  function sendFeedback(sentiment: "like" | "dislike") {
    if (!material || feedbackSent) return;
    setFeedbackSent(sentiment);
    void sendEvent({
      type: "feedback",
      material_id: material.material.material_id,
      sentiment,
      topic: material.material.topics[0],
    });
  }

  // 放弃时按滚动深度估算完成度
  const scrollMaxRef = useRef(0);
  useEffect(() => {
    if (phase !== "reading") return;
    const onScroll = () => {
      const doc = document.documentElement;
      const range = doc.scrollHeight - window.innerHeight;
      const frac = range <= 8 ? 1 : window.scrollY / range;
      scrollMaxRef.current = Math.max(scrollMaxRef.current, Math.min(1, frac));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [phase]);

  function scrollCompletion(): number {
    return Math.round(Math.min(0.99, scrollMaxRef.current) * 100) / 100;
  }

  if (phase === "idle" || phase === "error") {
    return (
      <main className={`container ${styles.page}`}>
        <section className={`card ${styles.startCard}`}>
          <span className="badge">当前水平 {band}</span>
          <h1 className={styles.startTitle}>准备好读一点英文了吗?</h1>
          <p className="muted">
            我们会按你的水平生成一篇约 {comfortableLength} 词的短文——大部分都认识,
            只夹着几个恰到好处的生词。
          </p>
          {phase === "error" && <p className={styles.error}>{error}</p>}
          <button className="btn btn-primary" onClick={generate}>
            {phase === "error" ? "再试一次" : "生成今日材料"}
          </button>
          <Link className={styles.backLink} href="/">
            返回首页
          </Link>
        </section>
      </main>
    );
  }

  if (phase === "generating") {
    return (
      <main className={`container ${styles.page}`}>
        <section className={`card ${styles.startCard}`}>
          <div className={styles.spinner} aria-hidden />
          <h1 className={styles.startTitle}>正在为你生成 N+1 材料…</h1>
          <p className="muted">生成引擎正在斟酌每个词的难度,通常需要十几秒,请稍等。</p>
        </section>
      </main>
    );
  }

  if (phase === "closing") {
    return (
      <main className={`container ${styles.page}`}>
        <section className={`card ${styles.startCard}`}>
          <div className={styles.spinner} aria-hidden />
          <h1 className={styles.startTitle}>正在更新你的学习档案…</h1>
          <p className="muted">本次阅读的收获正在写入档案,可能需要几秒钟。</p>
        </section>
      </main>
    );
  }

  if (phase === "done" && material) {
    return (
      <main className={`container ${styles.page}`}>
        <section className={`card ${styles.startCard}`}>
          <span className="badge">本次阅读完成</span>
          <h1 className={styles.startTitle}>读得不错。</h1>
          <p className="muted">
            本篇共 <strong>{material.material.length_words}</strong> 词,你查询了{" "}
            <strong>{lookedUp.size}</strong> 个词。
          </p>
          {material.new_items.length > 0 && (
            <div className={styles.newItems}>
              <h2 className={styles.newItemsTitle}>本篇遇到的新词</h2>
              <div className={styles.chipRow}>
                {material.new_items.map((w) => (
                  <span
                    key={w}
                    className={`chip ${knownMarked.has(w) ? styles.chipKnown : ""}`}
                  >
                    {w}
                    {knownMarked.has(w) ? " ✓" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className={styles.summaryActions}>
            <button className="btn btn-primary" onClick={() => setPhase("idle")}>
              再读一篇
            </button>
            <Link className="btn btn-ghost" href="/">
              返回首页
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (!material) return null;
  const meta = material.material;
  const paragraphs = meta.text.split(/\n+/).filter((p) => p.trim().length > 0);

  return (
    <main className={styles.readerPage} onClick={() => setSelection(null)}>
      <header className={styles.readerHeader}>
        <div className={styles.chipRow}>
          {meta.topics.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
        <p className="faint">
          难度 {meta.difficulty} · 约 {meta.length_words} 词
        </p>
      </header>

      <article className={styles.article}>
        {paragraphs.map((p, pi) => (
          <p key={pi} className={styles.paragraph}>
            {p.split(new RegExp(`(${WORD_RE.source})`, "g")).map((part, i) =>
              i % 2 === 1 ? (
                <button
                  key={i}
                  type="button"
                  className={`${styles.word} ${
                    lookedUp.has(toLemma(part))
                      ? knownMarked.has(toLemma(part))
                        ? styles.wordKnown
                        : styles.wordLooked
                      : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openWord(part, p);
                  }}
                >
                  {part}
                </button>
              ) : (
                part
              ),
            )}
          </p>
        ))}
      </article>

      {selection && (
        <div className={styles.popover} onClick={(e) => e.stopPropagation()}>
          <div className={styles.popoverLemma}>{selection.lemma}</div>
          <p className={styles.popoverSentence}>“{selection.sentence}”</p>
          <p className="faint">已记录一次查询,这个词之后会自然地再次出现。</p>
          <div className={styles.popoverActions}>
            <button
              className="btn btn-ghost"
              onClick={() => markKnown(selection.lemma)}
              disabled={knownMarked.has(selection.lemma)}
            >
              {knownMarked.has(selection.lemma) ? "已标记为认识" : "我认识了,以后别提示"}
            </button>
            <button className="btn btn-quiet" onClick={() => setSelection(null)}>
              继续阅读
            </button>
          </div>
        </div>
      )}

      <footer className={styles.readerFooter}>
        <div className={styles.feedbackRow}>
          <span className="faint">这篇怎么样?</span>
          <button
            className={`btn btn-ghost ${feedbackSent === "like" ? styles.feedbackActive : ""}`}
            onClick={() => sendFeedback("like")}
            disabled={feedbackSent !== null}
          >
            喜欢
          </button>
          <button
            className={`btn btn-ghost ${feedbackSent === "dislike" ? styles.feedbackActive : ""}`}
            onClick={() => sendFeedback("dislike")}
            disabled={feedbackSent !== null}
          >
            不太适合我
          </button>
        </div>
        <div className={styles.finishRow}>
          <button className="btn btn-primary" onClick={() => finish(true)}>
            完成阅读
          </button>
          <button className="btn btn-quiet" onClick={() => finish(false)}>
            没读完,离开
          </button>
        </div>
      </footer>
    </main>
  );
}
