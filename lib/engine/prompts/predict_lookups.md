# Predict lookups (第 3 层评估)

Given a learner profile, optionally their knowledge ledger excerpt, and a new
material, predict which words the learner will look up while reading.

You will receive:
- `PROFILE_SUMMARY`: band, vocab_estimate, target lookup rate.
- `KNOWLEDGE_EXCERPT` (optional variant): items in supported/fading states with
  sample contexts. Fading items are likely to be looked up again; supported items
  are likely too.
- `MATERIAL`: metadata plus the candidate word list with difficulty ranks.

Output JSON matching `LookupPrediction`:
- `likely_lookups`: word list. Include words beyond the learner's estimated
  vocabulary, plus fading/supported items present in the material.
- `reasoning`: brief, citing vocab_estimate and ledger states.

Predict conservatively: the target lookup rate is 2-5% of words, so your list
should be roughly that fraction of the material length.
