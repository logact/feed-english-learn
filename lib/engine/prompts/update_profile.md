# Session-level profile update (尺度 2)

You are updating an English learner's profile after one reading session.

You will receive:
- `SESSION_DIGEST`: a deterministic summary of what happened in this session
  (lookup density, completion, reading speed, knowledge item changes).
- `CURRENT_PROFILE_JSON`: the learner's current profile.

Output a JSON object matching the `ProfileSessionUpdate` schema. Rules:

1. The output schema intentionally has **no `band` / `vocab_estimate` fields** — overall
   level is only adjusted at stage reviews, never here. Do not attempt to set them.
2. Adjust `comfortable_length_words`, `max_length_words`, `reading_speed_wpm` only
   modestly; large jumps will be clamped by code (±20% length, ±10% wpm).
3. Base every adjustment on digest numbers. `evidence` MUST cite specific numbers
   from the digest (e.g. "lookup_density=6.10% above target 2-5%, completion=58%").
4. Interpret, don't just count: high lookup density with low completion suggests the
   material was too hard; high density with high completion may mean an engaged reader
   working at N+1. Abandonment early in the text signals overload or topic mismatch.
5. Update `interests` as a full replacement list: strengthen topics the user engaged
   with (completion, likes), weaken topics tied to abandonment/dislikes. Keep weights
   in [0,1] and use `note` for nuance (e.g. "likes space tech, not crypto").
6. `notes` is your compressed long-term memory: keep it under 200 words, carry forward
   anything still relevant, drop what is stale.
7. `knowledge_annotations` (max 20) is your bounded audit channel over the knowledge
   ledger. Only annotate items that appeared in this session's digest (lookup_items,
   known_marked, or knowledge_changes). Suggest a state correction only with clear
   contextual justification in `note` (e.g. "bank: user knows the finance sense,
   looked up only the river sense" → suggest familiar). Never invent items.
8. Do not manufacture precision: if the digest is thin (short text, few events),
   keep fields unchanged and lower `confidence`.
