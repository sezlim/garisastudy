"""Parse PE (정보관리기술사, 컴퓨터시스템응용기술사, optional 정보통신기술사) exam PDFs."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import pymupdf as fitz

PE_DIR = Path("참고(정보관리기술사, 컴퓨터응용시스템 기술사)")
DEFAULT_OUT = Path("data/pe_raw.json")

FOOTER_SUBNUM_RE = re.compile(r"^\s*\d+\s*-\s*\d+\s*$")
Q_START_RE = re.compile(r"^\s*(\d{1,2})\.\s*(.+)")
SUBITEM_RE = re.compile(r"^(?:[가-하]\.|[1-9]\d?\)|[①-⑩]|[•·\-])\s+")
INSTRUCTION_RE = re.compile(r"^※\s*(?:총|다음)")
ICT_SESSION_RE = re.compile(r"제\s*([1-4])\s*교시")


def classify_pe_type(path: Path) -> tuple[str, str]:
    """Return (exam_type, id_code) from PE filename."""
    name = path.name
    if "정보관리" in name:
        return "정보관리", "im"
    if "컴퓨터시스템응용" in name or "컴퓨터응용시스템" in name:
        return "컴응", "cs"
    if "정보통신기술사" in name:
        return "정보통신", "ict"
    return "기타", "etc"


def parse_pe_year_round(path: Path, first_page_text: str) -> tuple[int, str]:
    """Extract (round_num, normalized year_round) from filename and header text."""
    name = path.name
    m_round = re.search(r"제\s*(\d+)\s*회", name)
    m_year = re.search(r"(\d{4})\s*년", name)

    # Check header text for round (especially ICT files: "2025년도 제1회(기술사 제135회)")
    m_hdr_round = re.search(r"기술사\s*제\s*(\d+)\s*회", first_page_text)
    if m_hdr_round:
        rnd = int(m_hdr_round.group(1))
    elif m_round:
        rnd = int(m_round.group(1))
    else:
        rnd = 0

    year = int(m_year.group(1)) if m_year else 0
    if year and rnd:
        return rnd, f"{year}년(제{rnd}회)"
    if rnd:
        return rnd, f"제{rnd}회"
    return rnd, name


def extract_visual_lines(page: fitz.Page) -> list[dict[str, Any]]:
    """Extract visual lines using per-character gaps (Hancom PDFs omit space glyphs)."""
    chars: list[dict[str, Any]] = []
    raw = page.get_text("rawdict")
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                size = span.get("size", 10.0)
                for ch in span.get("chars", []):
                    x0, y0, x1, y1 = ch["bbox"]
                    chars.append({"c": ch["c"].replace("\xa0", " "), "x0": x0, "y0": y0, "x1": x1,
                                  "y1": y1, "yc": (y0 + y1) / 2.0, "size": size})
    chars.sort(key=lambda c: (c["yc"], c["x0"]))
    clusters: list[list[dict[str, Any]]] = []
    for c in chars:
        if clusters:
            cur = clusters[-1]
            mean_yc = sum(k["yc"] for k in cur) / len(cur)
            cy0 = min(k["y0"] for k in cur)
            cy1 = max(k["y1"] for k in cur)
            min_h = max(1.0, min(cy1 - cy0, c["y1"] - c["y0"]))
            ov = min(cy1, c["y1"]) - max(cy0, c["y0"])
            if abs(c["yc"] - mean_yc) <= 4.5 or ov >= 0.5 * min_h:
                cur.append(c)
                continue
        clusters.append([c])
    lines: list[dict[str, Any]] = []
    for cl in clusters:
        cl.sort(key=lambda k: k["x0"])
        parts: list[str] = []
        prev = None
        for c in cl:
            if prev is not None and c["c"].strip() and prev["c"].strip():
                if c["x0"] - prev["x1"] > 0.22 * c["size"]:
                    parts.append(" ")
            parts.append(c["c"])
            prev = c
        txt = re.sub(r"\s{2,}", " ", "".join(parts)).strip()
        if txt:
            lines.append({"x0": min(k["x0"] for k in cl), "y0": min(k["y0"] for k in cl),
                          "x1": max(k["x1"] for k in cl), "y1": max(k["y1"] for k in cl),
                          "yc": sum(k["yc"] for k in cl) / len(cl), "text": txt})
    return lines


def detect_page_session(lines: list[dict[str, Any]], is_ict: bool) -> int | None:
    """Detect session number (1..4) from top header region of a PE page."""
    if is_ict:
        for ln in lines:
            if ln["y0"] < 190.0:
                m = ICT_SESSION_RE.search(ln["text"])
                if m:
                    return int(m.group(1))
        return None

    # Q-Net format: top-left circle contains digit 1..4 above/near "교시"
    top_left = [ln for ln in lines if ln["x0"] < 130.0 and ln["y0"] < 150.0]
    for ln in top_left:
        t = ln["text"].strip()
        if t in ("1", "2", "3", "4"):
            return int(t)
        m = re.search(r"([1-4])\s*교시", t)
        if m:
            return int(m.group(1))
    return None


def filter_pe_body_lines(lines: list[dict[str, Any]], page_h: float, is_ict: bool) -> list[dict[str, Any]]:
    """Strip repeating header banner, instructions, page numbers, and footer disclaimers."""
    header_bottom_y = 0.0
    if is_ict:
        # ICT header table ends around y=195..220; check instruction line or divider
        for ln in lines:
            if ln["y0"] < 240.0 and ("자격종목" in ln["text"] or "수험번호" in ln["text"] or "교시" in ln["text"]):
                header_bottom_y = max(header_bottom_y, ln["y1"] + 6.0)
        if header_bottom_y < 150.0:
            header_bottom_y = 210.0
    else:
        for ln in lines:
            if ln["y0"] < 230.0 and ("수험자 응시 종목" in ln["text"] or "반드시 확인하시오" in ln["text"]):
                header_bottom_y = max(header_bottom_y, ln["y1"] + 4.0)
        if header_bottom_y < 140.0:
            header_bottom_y = 185.0

    kept: list[dict[str, Any]] = []
    for ln in lines:
        txt = ln["text"].strip()
        if ln["y0"] < header_bottom_y:
            continue
        if INSTRUCTION_RE.match(txt):
            continue
        if ln["y0"] > page_h * 0.85 and ("채점기준 및 기준답안" in txt or "공공기관의 정보공개" in txt):
            continue
        if FOOTER_SUBNUM_RE.match(txt):
            continue
        kept.append(ln)
    return kept


def format_pe_question(lines: list[str]) -> str:
    """Cleanly join wrapped PE question text while keeping sub-items on separate lines."""
    if not lines:
        return ""
    out: list[str] = []
    for raw in lines:
        s = re.sub(r"\s{2,}", " ", raw).strip()
        if not s:
            continue
        if not out:
            out.append(s)
            continue
        prev = out[-1]
        if SUBITEM_RE.match(s) or s.startswith(("결과:", "(단,", "단,", "<보기", "※")):
            out.append(s)
        elif prev.endswith(("다.", "시오.", "?", ")")) and not prev.endswith((")",)):
            out.append(s)
        elif prev.endswith("-"):
            out[-1] = prev[:-1] + s
        else:
            out[-1] = prev + " " + s
    return "\n".join(out).strip()


def parse_pe_pdf(path: Path) -> list[dict[str, Any]]:
    """Parse one PE PDF across all 1~4 sessions and split sequential questions."""
    exam_type, code = classify_pe_type(path)
    is_ict = exam_type == "정보통신"
    doc = fitz.open(path)
    if len(doc) == 0:
        doc.close()
        return []

    first_txt = doc[0].get_text("text")
    rnd, year_round = parse_pe_year_round(path, first_txt)

    session_lines: dict[int, list[dict[str, Any]]] = {1: [], 2: [], 3: [], 4: []}
    cur_sess = 0

    for pno in range(len(doc)):
        page = doc[pno]
        vis_lines = extract_visual_lines(page)
        if is_ict:
            sess = detect_page_session(vis_lines, True)
            cur_sess = sess if sess else max(cur_sess, 1)
        else:
            if any(INSTRUCTION_RE.match(ln["text"]) for ln in vis_lines) or cur_sess == 0:
                cur_sess = min(cur_sess + 1, 4)
        body_lines = filter_pe_body_lines(vis_lines, page.rect.height, is_ict)
        session_lines[cur_sess].extend(body_lines)

    doc.close()

    records: list[dict[str, Any]] = []
    for sess_num in (1, 2, 3, 4):
        lines = session_lines[sess_num]
        if not lines:
            continue
        # Left margin baseline for top-level numbered questions in this session
        numbered_x0s = [
            ln["x0"] for ln in lines
            if Q_START_RE.match(ln["text"]) and ln["x0"] < 140.0
        ]
        body_left_x = min(numbered_x0s) if numbered_x0s else min(ln["x0"] for ln in lines)

        expected_q = 1
        grouped: list[tuple[int, list[str]]] = []

        for ln in lines:
            m = Q_START_RE.match(ln["text"])
            if m and int(m.group(1)) == expected_q and ln["x0"] <= body_left_x + 25.0:
                grouped.append((expected_q, [m.group(2).strip()]))
                expected_q += 1
            else:
                if grouped:
                    grouped[-1][1].append(ln["text"])

        for qnum, qlines in grouped:
            q_id = f"pe_{code}_{rnd:03d}_s{sess_num}_{qnum:02d}"
            records.append(
                {
                    "id": q_id,
                    "exam_type": exam_type,
                    "year_round": year_round,
                    "session": f"{sess_num}교시",
                    "number": qnum,
                    "question": format_pe_question(qlines),
                }
            )

    return records


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Parse PE (기술사) exam PDFs.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", type=Path, help="Single PE PDF file to parse.")
    group.add_argument("--all", action="store_true", help="Parse all PE PDFs in 참고 folder.")
    parser.add_argument("--include-ict", action="store_true", help="Also include 정보통신기술사 PDFs.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output JSON path.")
    args = parser.parse_args()

    if args.file:
        pdf_files = [args.file]
    else:
        pdf_files = []
        for p in sorted(PE_DIR.glob("*.pdf")):
            etype, _ = classify_pe_type(p)
            if etype == "정보통신" and not args.include_ict:
                continue
            pdf_files.append(p)

    all_records: list[dict[str, Any]] = []
    for pdf in pdf_files:
        recs = parse_pe_pdf(pdf)
        all_records.extend(recs)
        by_sess = {s: sum(1 for r in recs if r["session"] == f"{s}교시") for s in (1, 2, 3, 4)}
        print(f"Parsed {pdf.name}: {len(recs)} questions {by_sess}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(all_records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(all_records)} records -> {args.out}")


if __name__ == "__main__":
    main()
