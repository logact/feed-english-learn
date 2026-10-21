#!/usr/bin/env python3
"""构建真实英文词频表（组件 2 的 RankOf 数据源）。

数据源：wordfreq（多语料融合：字幕/维基/书籍/社媒；CC BY-SA 4.0 —— 衍生词表
同许可共享并署名，见输出文件的 source/license 字段）。

流程：
1. top_n_list 取高频表面形 → 清洗（数字、非字母、单字母、悬挂撇号等垃圾）
2. 交叉锚定（轻量版）：内置教学基础词样本（入门词汇恒应为高频），
   报告其 rank 分布；缺失/过低的词列出供人工复核——防"该认识的被判成生词"
3. 落盘 lib/engine/lexicon-en.json（JSON 数组，下标 + 1 即 rank）

完整 NGSL diff（可选人工步骤）：从 newgeneralservicelist.com 下载 NGSL 词表后，
用同样的方式核对 NGSL 2800 词在本表前 5000 名内的覆盖率及反向差异项。

用法：
  python3 -m venv .venv-lexicon && .venv-lexicon/bin/pip install wordfreq
  .venv-lexicon/bin/python scripts/build-lexicon.py
"""
import json
import re
import sys
from pathlib import Path

from wordfreq import top_n_list

OUT = Path("lib/engine/lexicon-en.json")
TOP_N_RAW = 40000  # 原始取词量（清洗损耗后截断到 KEEP）
KEEP = 15000  # 覆盖 C2（vocab_estimate ~8000）并留出 stretch 区

# 教学基础词样本：任何合理频率表都应把它们排在很靠前（< 2000~3000）
BASIC_SAMPLE = """
time people way water day man thing woman life child world school family student
group country problem hand part place case week company question work night point
home room mother area money story fact month right study book eye job word business
issue side kind head house service friend father power hour game line end member
law car city name team minute idea body parent face level door health person art
war history party result change morning reason research girl moment air teacher
food education boy age policy music market sense nation plan college interest death
experience effect class care field development eat drink sleep happy big small fast
""".split()

# 难词样本：应排在靠后（> 5000），用于反向 sanity check
HARD_SAMPLE = ["ubiquitous", "ephemeral", "obfuscate", "parsimonious", "antediluvian"]

WORD_RE = re.compile(r"[a-z][a-z'\-]*")


def clean(words: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for w in words:
        w = w.strip().lower()
        if not WORD_RE.fullmatch(w):
            continue
        if len(w) == 1 and w not in ("a", "i"):
            continue
        if w.startswith(("'", "-")) or w.endswith(("'", "-")):
            continue
        if w in seen:
            continue
        seen.add(w)
        out.append(w)
    return out


def main() -> int:
    raw = top_n_list("en", TOP_N_RAW)
    words = clean(raw)[:KEEP]
    rank_of = {w: i + 1 for i, w in enumerate(words)}

    # ---- 交叉锚定报告 ----
    basic_hits = [(w, rank_of.get(w)) for w in BASIC_SAMPLE]
    basic_missing = [w for w, r in basic_hits if r is None]
    basic_far = [(w, r) for w, r in basic_hits if r is not None and r > 5000]
    basic_ranks = [r for _, r in basic_hits if r is not None]
    hard_ranks = {w: rank_of.get(w) for w in HARD_SAMPLE}

    print(f"kept {len(words)} words (raw {len(raw)})")
    print(
        f"basic sample: {len(basic_hits)} words, "
        f"median rank {sorted(basic_ranks)[len(basic_ranks) // 2] if basic_ranks else '-'}, "
        f"max {max(basic_ranks) if basic_ranks else '-'}"
    )
    print(f"basic missing from table: {basic_missing or 'none'}")
    print(f"basic ranked > 5000 (复核对象): {basic_far or 'none'}")
    print(f"hard sample ranks: {hard_ranks}")

    ok = len(basic_missing) <= len(BASIC_SAMPLE) * 0.1 and len(basic_far) <= len(BASIC_SAMPLE) * 0.1
    if not ok:
        print("ANCHOR CHECK FAILED：基础词缺失/靠后比例超 10%，请人工复核语料与清洗规则")
        return 1

    OUT.write_text(
        json.dumps(
            {
                "source": "wordfreq (multi-corpus), top surface forms, cleaned",
                "license": "CC BY-SA 4.0",
                "count": len(words),
                "ranks": words,
            },
            ensure_ascii=False,
        )
    )
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
