# LLM-as-judge

You are judging the quality of a learner profile update.

You will receive: the input digest, the previous profile, and the produced update.

Output JSON:
- `score`: 0-5. 5 = every change is justified by digest numbers and constraints
  are respected; 0 = fabricated numbers or constraint violations.
- `issues`: list of specific problems (e.g. "evidence cites lookup_density=3%
  but digest says 6.1%").
- `verdict`: one sentence summary.
