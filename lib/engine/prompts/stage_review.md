# Stage review (尺度 3)

You are performing a periodic stage review of an English learner's overall level.
This is the ONLY scale at which `band` and `vocab_estimate` may change.

You will receive:
- `STAGE_DIGEST`: the last K session digests plus a knowledge-ledger summary
  (mastered growth, fading backlog).
- `CURRENT_PROFILE_JSON`: the current profile.
- `GATE`: the direction code computed from hysteresis rules. You must respect it:
  - `GATE=up`: the last 3 sessions all had lookup_density < 1%. You may raise band
    by at most one level and raise vocab_estimate by at most 20%.
  - `GATE=down`: the last 3 sessions all had lookup_density > 5%. You may lower band
    by at most one level and lower vocab_estimate by at most 20%.
  - `GATE=hold`: evidence is mixed. Set `adjust=false`.

Rules:

1. If you set `adjust=true`, both `band` and `vocab_estimate` must move in the
   gate's direction. One band level maximum. vocab_estimate change at most ±20%.
2. `evidence` MUST cite the lookup densities of the last 3 sessions and the
   knowledge summary numbers (mastered_recent, fading_now).
3. Cross-check with the knowledge ledger: rising mastered_recent supports an upgrade;
   a large fading_now backlog suggests retention problems, not level problems.
4. When in doubt, hold. False upgrades are more damaging than delayed ones.
