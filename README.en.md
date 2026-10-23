# feed-english-learn

[中文](README.md) | English

An adaptive English learning system built on the **Comprehensible Input** hypothesis: it automatically maintains a model of each user's level and interests, and continuously generates N+1 reading materials (covering 95%–98% familiar vocabulary), so users acquire English through fluent, positive reading experiences.

## Features

- **Passwordless email login**: log in with just an email address; new emails create accounts automatically. Sessions last 30 days via HttpOnly cookies; only token hashes are stored.
- **Onboarding**: set nickname, current level (band), and interests as a cold-start profile; re-assessment is supported later (`/reassess`).
- **Personalized material generation**: the LLM generates reading materials with appropriate length and code-validated difficulty based on the user's level, vocabulary ledger, and interests; fading old words are deliberately revived in the text (spaced repetition).
- **Reading interface**: the text is rendered word by word — tap a word to look it up, or mark it as "I know this"; after finishing, users can give feedback: "too easy / just right / too hard".
- **Adaptive learning loop**: behavior from every reading session (lookups, exposures, speed, completion, feedback) flows back to update the user model, and the next generated material adjusts accordingly.
- **Profile page**: view current level estimates, interests, and reading state.
- **Debug visualization** (`/debug/[userId]`): profile version history, vocabulary grouped by state, an audit timeline of every LLM update, and LLM call details with cost summaries.

### The Adaptive Loop (main product flow)

```
      ┌──────────────────────────────────────────────┐
      │                                              │
      ▼                                              │
① UserProfile                    ④ Behavior events flow back to
(band/vocab/interests/speed)      update profile & vocab ledger
      │                           (session_end → LLM update;
      │                           word_lookup → instant state machine)
      ▼                                              │
② Build TargetSpec ──→ ③ Generate N+1 material ──→ User reads ──┘
(difficulty/length/               (agentic loop with
review words/new-word budget)      code-side acceptance)
```

## Core Logic Implementation

The design philosophy in one sentence: **code tells the LLM "what happened"; the LLM tells the system "what it means".** All numeric decisions (state transitions, clamping, hysteresis, material acceptance) live in deterministic code; the LLM only interprets (profile updates) and creates (writes materials), and both are gated by code. See [docs/how-it-works.md](docs/how-it-works.md) and [docs/user-engine.md](docs/user-engine.md) for details (in Chinese).

### Two-Layer User Model

- **UserProfile (slow variables, maintained by the LLM)**: generalized judgments about "unseen word difficulty" — band, vocabulary estimate, comfortable length, reading speed, interests. Handles cold start and non-lexical signals (speed, abandonment).
- **KnowledgeItem (fast variables, maintained by code)**: the mastery state of each specific word, driven by a deterministic state machine:

```
             lookup         appears unlooked-up in      3 cumulative query-free
                          a later session                  exposures
null ──lookup──▶ new ──▶ supported ──exposure──▶ familiar ──────────▶ mastered
                  ▲              │                     │                ▲
                  └──────────────┴── looked up = still ┴────────────────┘
                                      needs support
                        familiar 14 days / mastered 30 days unseen → fading (lazy)
```

### Three Time Scales (a structural anti-oscillation scheme)

| Scale | Trigger | What the LLM may change | Code-enforced constraints |
|---|---|---|---|
| 1 per event | lookup / mark-known / exposure | — | Vocabulary state machine (pure functions, fully unit-tested) |
| 2 per session | session_end | length / speed / interests / notes | Output schema has no band; length ±20%, speed ±10% clamped by code |
| 3 every 5 sessions | after scale 2 | band / vocabulary (rejectable) | Hysteresis gate: 3 consecutive sessions of same-direction signals required; band changes by at most 1 level |

The only input to LLM profile updates is the **digest** (the event stream compressed into a stable-format text summary). Every update's prompt version, raw response, and actual delta are written to `update_journal` — auditable and replayable.

### Material Generation: LLM Proposes, Code Decides

1. **TargetSpec (the order)**: translates the user model into generation constraints — band, length range, top-3 interests, review_items (old words required to reappear), new-word budget, avoid_items (frustrating words looked up many times, deferred).
2. **Agentic loop (max 8 turns)**: each turn the LLM outputs one action — `check_words` (ask the system whether the user knows these words), `check_draft` (request a full-draft review), `submit` (deliver); code executes and returns results as `TOOL_RESULT`.
3. **Acceptance gate checkDraft (N+1, digitized)**: every word is classified by "ledger state + frequency rank"; five criteria must all pass (length in range, predicted lookup rate ≤ cap — i.e. ≥95–98% coverage, new-word count ≤ budget, no avoid words, ≥80% of review words present). **Acceptance authority lies entirely in code.**

### Event Stream & Storage

- The only write channel between UI and engine is 7 reading event types (`contracts/events.ts`), stored append-only with `event_id` idempotency-key deduplication, supporting full replay (`sim/replay.ts`).
- Each event's insert plus side effects run in a single transaction; LLM calls happen outside the transaction, so failures never leave half-written state.
- SQLite (better-sqlite3 + drizzle), 10 tables: event stream, profiles & version history, vocabulary ledger & state history, materials, update audit, LLM call observability, accounts & sessions.

## Getting Started

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

Without an LLM key, the built-in MockLLMClient lets you experience the full loop; configure one to use a real model.

### Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | LLM service config (OpenAI-compatible endpoint); built-in Mock when no key | `gpt-4o-mini` |
| `DAILY_TOKEN_LIMIT` | Per-user daily token limit (prompt + completion); `0` = unlimited | `100000` |
| `SYSTEM_DAILY_TOKEN_LIMIT` | System-wide daily token limit (all users); `0` = unlimited | unlimited |
| `ENGINE_DB_PATH` | SQLite database path | `data/engine.db` |
| `LOG_LEVEL` / `LOG_FILE` / `LLM_LOG_FILE` | Log level and file paths | `info` / `data/app.log` / `data/llm-calls.jsonl` |
| `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` | Token pricing (USD per 1M tokens) for self-hosted models, used for cost estimation | built-in price table |

Once a limit is exceeded, all LLM calls are blocked: the material generation API returns 429, and background profile updates are silently skipped (reset at UTC midnight).

### Common Commands

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Develop / build / production start |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | Test / typecheck / lint |
| `pnpm demo` | Full-loop demo with the Mock client |
| `pnpm sim:personas` | Run 5 virtual personas through the full loop, output estimation quality metrics |
| `pnpm sim:eval` | Holdout-set prediction comparison (validates layered modeling) |
| `pnpm sim:replay <userId>` | Replay-derived vs current profile — exposes memory drift |
| `pnpm contracts:export` | Export contract-layer JSON Schemas |

## Project Structure

| Directory | Role |
|---|---|
| `contracts/` | All cross-module data structures (zod schemas) — the system's "language" |
| `lib/engine/` | Engine core; independent of Next.js, runs standalone via tsx/vitest |
| `app/` | Next.js UI + thin API shell, only translates "HTTP ↔ engine" |
| `sim/` | Simulation: virtual personas run the full loop to validate engine quality |
| `tests/` | vitest, focused on pure functions (state machine / clamp / digest / acceptance) |
| `docs/` | [How it works](docs/how-it-works.md), [user engine design](docs/user-engine.md), [PRD](PRD.md) (in Chinese) |
