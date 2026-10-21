"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; needsOnboarding?: boolean }
        | null;

      if (!response.ok || typeof data?.needsOnboarding !== "boolean") {
        setError(data?.error ?? "登录失败，请稍后再试");
        setSubmitting(false);
        return;
      }

      router.push(data.needsOnboarding ? "/onboarding" : "/");
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label className={styles.label} htmlFor="email">
        邮箱地址
      </label>
      <input
        id="email"
        className={styles.input}
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        maxLength={254}
        required
      />
      {error && <p className={styles.error}>{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? "正在登录…" : "继续"}
      </button>
      <p className={`faint ${styles.note}`}>请使用自己的邮箱，以便下次找回学习进度。</p>
    </form>
  );
}
