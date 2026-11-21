"""Extract all 1,560 official NIA Gamrisa answers (2014-2026) and merge with re-parsed spacing-fixed text."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import pymupdf as fitz

SCRATCH_DIR = Path(
    "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p_devbox/"
    "e59066f4-cb74-4726-99d7-488358cf5cbc/scratch/nia_answers"
)

MARKERS = {"①": 1, "②": 2, "③": 3, "④": 4, "➀": 1, "➁": 2, "➂": 3, "➃": 4}
Q_RE = re.compile(r"^\s*(\d{1,3})\s*\.\s*(.*)")

# Visually verified from the official NIA answer PDFs where the circled marker itself wasn't bolded
# or was inside a raster/table cell
VERIFIED_OVERRIDES: dict[tuple[str, int], list[int]] = {
    ("2014년(제15회)", 103): [1],  # ① Pharming (text bolded, ① not bolded)
    ("2015년(제16회)", 56): [2],   # ② 응용(프로그램) 서버 / 비즈니스 로직 (text bolded)
    ("2015년(제16회)", 63): [2],   # ② 슬라이싱 / 다이싱 (text bolded)
    ("2018년(제19회)", 16): [3],   # ③ (bolded inside diagram image)
    ("2022년(제23회)", 5): [4],    # ④ 고객이 발견한 결함... (text bolded, ④ not bolded)
    ("2025년(제26회)", 30): [4],   # ④ (bolded in table header cell)
}


def extract_texttrace_answers(pdf_path: Path) -> dict[int, list[int]]:
    """Extract official bold answers via PyMuPDF texttrace type==1 (fill+stroke faux bold)."""
    doc = fitz.open(pdf_path)
    questions: dict[int, set[int]] = {}
    current_q: int | None = None
    expected_q = 1

    for pno in range(len(doc)):
        page = doc[pno]
        txt_all = re.sub(r"\s+", "", page.get_text("text"))
        if any(k in txt_all for k in ("수험자유의사항", "응시자유의사항", "문제지유형", "자격검정", "답안지작성요령")):
            continue
        w = page.rect.width
        mid_x = w / 2.0

        col_lines: dict[int, list[tuple[float, float, str]]] = {0: [], 1: []}
        for b in page.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            for ln in b["lines"]:
                t = "".join(sp["text"] for sp in ln["spans"]).strip()
                if not t or re.match(r"^-\s*\d+\s*-$", t):
                    continue
                x0, y0, x1, y1 = ln["bbox"]
                col = 0 if (x0 + x1) / 2.0 < mid_x else 1
                col_lines[col].append((y0, x0, t))

        col_bold: dict[int, list[tuple[float, float, str]]] = {0: [], 1: []}
        for it in page.get_texttrace():
            if it["type"] == 1:
                chars = "".join(chr(c[0]) for c in it["chars"] if c[0] > 0)
                x0, y0, x1, y1 = it["bbox"]
                col = 0 if (x0 + x1) / 2.0 < mid_x else 1
                col_bold[col].append((y0, x0, chars))

        for col in (0, 1):
            lines = sorted(col_lines[col], key=lambda x: (x[0], x[1]))
            bolds = sorted(col_bold[col], key=lambda x: (x[0], x[1]))
            anchors: list[tuple[float, int]] = []
            for y0, x0, t in lines:
                m = Q_RE.match(t)
                if m:
                    qn = int(m.group(1))
                    margin_ok = (x0 <= 115.0) if col == 0 else (mid_x - 10.0 <= x0 <= mid_x + 95.0)
                    if qn == expected_q and margin_ok:
                        anchors.append((y0, qn))
                        questions[qn] = set()
                        expected_q += 1
            bands: list[tuple[float, float, int]] = []
            if anchors:
                if current_q is not None:
                    bands.append((0.0, anchors[0][0] - 1.0, current_q))
                for i, (ay, qn) in enumerate(anchors):
                    ay_end = anchors[i + 1][0] - 1.0 if i + 1 < len(anchors) else page.rect.height
                    bands.append((ay - 1.0, ay_end, qn))
                current_q = anchors[-1][1]
            elif current_q is not None:
                bands.append((0.0, page.rect.height, current_q))

            for y0, x0, chars in bolds:
                for b0, b1, qn in bands:
                    if b0 <= y0 < b1:
                        for ch in chars:
                            if ch in MARKERS:
                                questions[qn].add(MARKERS[ch])
                        break

    return {qn: sorted(opts) for qn, opts in questions.items()}


def extract_2024_table_answers(pdf_path: Path) -> dict[int, list[int]]:
    """Extract 2024 (25th) A형 official answer table from page 1."""
    doc = fitz.open(pdf_path)
    page = doc[0]  # Page 1 = A형 (verified to match local 2024 PDF)
    tokens = [tok.strip() for tok in page.get_text("text").splitlines() if tok.strip()]
    ans: dict[int, list[int]] = {}
    i = 0
    while i < len(tokens) - 1:
        if tokens[i].isdigit():
            qn = int(tokens[i])
            if 1 <= qn <= 120:
                nxt = tokens[i + 1]
                opts = [MARKERS[ch] for ch in nxt if ch in MARKERS]
                if opts:
                    ans[qn] = sorted(set(opts))
                    i += 2
                    continue
        i += 1
    return ans


def extract_2025_vector_answers(pdf_path: Path) -> dict[int, list[int]]:
    """Extract 2025 (26th) A형 official answers from 2-up landscape PDF with vector-outlined bold glyphs."""
    doc = fitz.open(pdf_path)
    qs25: dict[int, set[int]] = {}
    expected_q = 1
    current_q: int | None = None

    for pno in range(len(doc)):
        page = doc[pno]
        w = page.rect.width
        col_bounds = [(0, w * 0.25), (w * 0.25, w * 0.5), (w * 0.5, w * 0.75), (w * 0.75, w)]

        bold_rects: list[fitz.Rect] = []
        for d in page.get_drawings():
            r = d["rect"]
            if (
                2.0 <= r.width <= 12.0
                and 2.0 <= r.height <= 12.0
                and (d.get("fill") == (0.0, 0.0, 0.0) or d.get("color") == (0.0, 0.0, 0.0))
            ):
                bold_rects.append(r)

        col_lines: dict[int, list[tuple[float, float, str, list[dict[str, Any]]]]] = {c: [] for c in range(4)}
        for b in page.get_text("rawdict")["blocks"]:
            if b["type"] != 0:
                continue
            for ln in b["lines"]:
                chars = [ch for sp in ln["spans"] for ch in sp.get("chars", [])]
                if not chars:
                    continue
                t = "".join(c["c"] for c in chars).strip()
                if not t or re.match(r"^-\s*\d+\s*-$", t):
                    continue
                x0, y0, x1, y1 = ln["bbox"]
                if pno == 0 and x0 < w * 0.5:
                    continue
                xc = (x0 + x1) / 2.0
                col = min(3, max(0, int(xc / (w * 0.25))))
                col_lines[col].append((y0, x0, t, chars))

        for col in range(4):
            lines = sorted(col_lines[col], key=lambda x: (x[0], x[1]))
            c_left = col_bounds[col][0]
            anchors: list[tuple[float, int]] = []
            for y0, x0, t, chars in lines:
                m = Q_RE.match(t)
                if m:
                    qn = int(m.group(1))
                    if qn == expected_q and (x0 - c_left) <= 65.0:
                        anchors.append((y0, qn))
                        qs25[qn] = set()
                        expected_q += 1
            bands: list[tuple[float, float, int]] = []
            if anchors:
                if current_q is not None:
                    bands.append((0.0, anchors[0][0] - 1.0, current_q))
                for i, (ay, qn) in enumerate(anchors):
                    ay_end = anchors[i + 1][0] - 1.0 if i + 1 < len(anchors) else page.rect.height
                    bands.append((ay - 1.0, ay_end, qn))
                current_q = anchors[-1][1]
            elif current_q is not None and not (pno == 0 and col < 2):
                bands.append((0.0, page.rect.height, current_q))

            for y0, x0, t, chars in lines:
                qn_match = None
                for b0, b1, qn in bands:
                    if b0 <= y0 < b1:
                        qn_match = qn
                        break
                if qn_match is None:
                    continue
                for ch in chars:
                    if ch["c"] in MARKERS:
                        cr = fitz.Rect(ch["bbox"])
                        cr_exp = fitz.Rect(cr.x0 - 2, cr.y0 - 2, cr.x1 + 2, cr.y1 + 2)
                        if any(cr_exp.intersects(br) for br in bold_rects):
                            qs25[qn_match].add(MARKERS[ch["c"]])

    return {qn: sorted(opts) for qn, opts in qs25.items()}


def main() -> None:
    all_answers: dict[tuple[str, int], list[int]] = {}

    texttrace_map = [
        ("2014년(제15회)", "2014_15_ans.pdf"),
        ("2015년(제16회)", "2015_16_ans.pdf"),
        ("2016년(제17회)", "2016_17_ans.pdf"),
        ("2017년(제18회)", "2017_18_ans.pdf"),
        ("2018년(제19회)", "2018_19_ans.pdf"),
        ("2019년(제20회)", "2019_20_ans.pdf"),
        ("2020년(제21회)", "2020_21_ans.pdf"),
        ("2021년(제22회)", "2021_22_ans.pdf"),
        ("2022년(제23회)", "2022_23_ans.pdf"),
        ("2023년(제24회)", "2023_24_ans.pdf"),
        ("2026년(제27회)", "2026_27_B_ans.pdf"),
    ]

    for yr_key, fname in texttrace_map:
        res = extract_texttrace_answers(SCRATCH_DIR / fname)
        for qn, opts in res.items():
            all_answers[(yr_key, qn)] = opts

    for qn, opts in extract_2024_table_answers(SCRATCH_DIR / "2024_25_ans.pdf").items():
        all_answers[("2024년(제25회)", qn)] = opts

    for qn, opts in extract_2025_vector_answers(SCRATCH_DIR / "2025_26_A_ans.pdf").items():
        all_answers[("2025년(제26회)", qn)] = opts

    for k, v in VERIFIED_OVERRIDES.items():
        all_answers[k] = v

    # Load reparsed text & existing raw/tagged JSONs
    with open("/tmp/gamrisa_reparsed.json", encoding="utf-8") as f:
        reparsed = {q["id"]: q for q in json.load(f)}
    with open("data/gamrisa_raw.json", encoding="utf-8") as f:
        raw_list = json.load(f)
    with open("data/gamrisa_tagged.json", encoding="utf-8") as f:
        tagged_list = json.load(f)

    official_by_id: dict[str, list[int]] = {}
    missing = []
    for q in raw_list:
        key = (q["year_round"], q["number"])
        opts = all_answers.get(key, [])
        if not opts:
            missing.append(q["id"])
        official_by_id[q["id"]] = opts

    assert not missing, f"Missing answers for: {missing}"
    assert len(official_by_id) == 1560, f"Expected 1560 answers, got {len(official_by_id)}"

    # Save data/official_answers.json
    with open("data/official_answers.json", "w", encoding="utf-8") as f:
        json.dump(official_by_id, f, ensure_ascii=False, indent=2)

    # Update raw_list and tagged_list
    for lst in (raw_list, tagged_list):
        for q in lst:
            rp = reparsed.get(q["id"])
            if rp:
                q["question"] = rp["question"]
                q["options"] = rp["options"]
            opts = official_by_id[q["id"]]
            q["answer"] = opts[0]
            q["answers"] = opts

    with open("data/gamrisa_raw.json", "w", encoding="utf-8") as f:
        json.dump(raw_list, f, ensure_ascii=False, indent=2)
    with open("data/gamrisa_tagged.json", "w", encoding="utf-8") as f:
        json.dump(tagged_list, f, ensure_ascii=False, indent=2)

    multi_cnt = sum(1 for v in official_by_id.values() if len(v) > 1)
    print(f"SUCCESS: Merged {len(official_by_id)} official answers (multi-answer: {multi_cnt}) and updated spacing!")


if __name__ == "__main__":
    main()
