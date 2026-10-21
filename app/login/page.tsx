import { redirect } from "next/navigation";
import { getDefaultStorage } from "@/lib/engine/storage";
import { getCurrentAccount } from "@/lib/session";
import LoginForm from "./login-form";
import styles from "./page.module.css";

export const instant = false;

export default async function LoginPage() {
  const storage = getDefaultStorage();
  const account = await getCurrentAccount(storage);
  if (account) {
    redirect(storage.getProfile(account.userId) ? "/" : "/onboarding");
  }

  return (
    <main className={`container ${styles.page}`}>
      <section className={`card ${styles.card}`}>
        <span className="badge">悦读英语</span>
        <header className={styles.header}>
          <h1 className={styles.title}>邮箱快速登录</h1>
          <p className="muted">无需密码或验证码，新邮箱会自动创建账号。</p>
        </header>
        <LoginForm />
      </section>
    </main>
  );
}
