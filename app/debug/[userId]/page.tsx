import { connection } from "next/server";
import { getDefaultStorage } from "@/lib/engine/storage";
import { effectiveState } from "@/lib/engine/knowledge";
import { KNOWLEDGE_STATES, type KnowledgeState } from "@/contracts/knowledge";

// 调试页总是阻塞式按请求渲染（cacheComponents 模式下禁用即时 prerender）
export const instant = false;

const mono: React.CSSProperties = { fontFamily: "monospace" };
const box: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 6,
  padding: 12,
  marginBottom: 16,
};

export default async function DebugUserPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  await connection(); // better-sqlite3 同步驱动：声明按请求读取
  const { userId } = await params;
  const storage = getDefaultStorage();
  const now = storage.lastEventTs(userId) ?? new Date().toISOString();

  const profile = storage.getProfile(userId);
  const snapshots = storage.listSnapshots(userId);
  const items = storage
    .listKnowledgeItems(userId)
    .map((it) => ({ ...it, effective_state: effectiveState(it, now) as KnowledgeState }));
  const journal = storage.listJournal(userId);
  const changes = storage.listKnowledgeChanges(userId);

  const byState = new Map<KnowledgeState, typeof items>();
  for (const s of KNOWLEDGE_STATES) byState.set(s, []);
  for (const it of items) byState.get(it.effective_state)!.push(it);

  return (
    <main style={{ ...mono, padding: 24, maxWidth: 960 }}>
      <h1>Debug: {userId}</h1>
      <p>
        now(event-time)={now} · snapshots={snapshots.length} · knowledge_items={items.length} ·
        journal={journal.length}
      </p>

      <section style={box}>
        <h2>Profile (current)</h2>
        {profile ? (
          <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(profile, null, 2)}</pre>
        ) : (
          <p>no profile yet</p>
        )}
      </section>

      <section style={box}>
        <h2>Profile version history ({snapshots.length})</h2>
        <table cellPadding={4} style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th>v</th><th>band</th><th>vocab</th><th>len</th><th>wpm</th><th>since_review</th><th>updated_at</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.version}>
                <td>{s.version}</td>
                <td>{s.reading_state.band}</td>
                <td>{s.reading_state.vocab_estimate}</td>
                <td>{s.reading_state.comfortable_length_words}</td>
                <td>{s.reading_state.reading_speed_wpm}</td>
                <td>{s.reading_state.sessions_since_review}</td>
                <td>{s.updated_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={box}>
        <h2>Knowledge items by state</h2>
        {KNOWLEDGE_STATES.map((state) => {
          const list = byState.get(state) ?? [];
          if (list.length === 0) return null;
          return (
            <details key={state} open={state !== "mastered"}>
              <summary>
                <b>{state}</b> ({list.length})
              </summary>
              <ul>
                {list.map((it) => (
                  <li key={it.item}>
                    <b>{it.item}</b> lookups={it.lookup_count} exposures={it.exposure_count}{" "}
                    last_seen={it.last_seen.slice(0, 10)}
                    {it.note ? ` note="${it.note}"` : ""}
                    {it.sample_contexts[0] ? (
                      <div style={{ color: "#666" }}>“{it.sample_contexts[0]}”</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </section>

      <section style={box}>
        <h2>Knowledge changes ({changes.length})</h2>
        <ul>
          {changes.map((c, i) => (
            <li key={i}>
              {c.ts.slice(0, 10)} <b>{c.item}</b> {c.from_state ?? "∅"}→{c.to_state} [{c.trigger}]
              {c.note ? ` — ${c.note}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section style={box}>
        <h2>Update journal ({journal.length})</h2>
        {journal.map((j) => (
          <details key={j.id} style={{ marginBottom: 8 }}>
            <summary>
              #{j.id} <b>{j.scale}</b> model={j.model} prompt={j.promptVersion} at{" "}
              {j.createdAt.slice(0, 19)}
            </summary>
            <h4>delta</h4>
            <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(j.delta, null, 2)}</pre>
            <h4>input digest</h4>
            <pre style={{ whiteSpace: "pre-wrap" }}>{j.inputSummary}</pre>
            <h4>raw LLM response</h4>
            <pre style={{ whiteSpace: "pre-wrap" }}>{j.rawResponse || "(none)"}</pre>
          </details>
        ))}
      </section>
    </main>
  );
}
