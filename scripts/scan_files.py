"""Read-only inventory and PDF health scan for past exam folders."""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import pymupdf as fitz

GAMRISA_DIR = Path("정보시스템감리사")
PE_DIR = Path("참고(정보관리기술사, 컴퓨터응용시스템 기술사)")
REPORT_PATH = Path("data/scan_report.json")

HANGUL_RE = re.compile(r"[가-힣]")
CIRCLED_SET = set("①②③④➀➁➂➃")
Q_START_RE = re.compile(r"^\s*(\d{1,3})\s*\.\s*(.*)")
FOOTER_RE = re.compile(r"^\s*-\s*\d+\s*-\s*$")


def md5_file(path: Path) -> str:
    """Compute MD5 hex digest for a file."""
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def is_visible_drawing(d: dict[str, Any]) -> bool:
    """Return True if drawing has a visible stroke or non-white fill."""
    color = d.get("color")
    fill = d.get("fill")
    has_stroke = color is not None and color != (1.0, 1.0, 1.0)
    has_fill = fill is not None and fill != (1.0, 1.0, 1.0)
    return has_stroke or has_fill


def detect_mid_x(page: fitz.Page) -> float:
    """Detect vertical column divider x-coordinate or fallback to half width."""
    w = page.rect.width
    h = page.rect.height
    candidates: list[tuple[float, float, float]] = []
    for d in page.get_drawings():
        if not is_visible_drawing(d):
            continue
        rect = d.get("rect")
        if rect is None:
            continue
        rw = rect.width
        rh = rect.height
        xc = (rect.x0 + rect.x1) / 2.0
        if 0.48 * w <= xc <= 0.52 * w and rh > 0.30 * h and rw <= 3.0:
            candidates.append((abs(xc - w / 2.0), -rh, xc))
    if candidates:
        candidates.sort()
        return candidates[0][2]
    return w / 2.0


def extract_sorted_lines(page: fitz.Page, mid_x: float) -> dict[int, list[dict[str, Any]]]:
    """Extract coordinate-sorted lines per column (0=left, 1=right)."""
    page_h = page.rect.height
    col_spans: dict[int, list[dict[str, Any]]] = {0: [], 1: []}
    tdict = page.get_text("dict")
    for block in tdict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                txt = span.get("text", "")
                if not txt.strip():
                    continue
                x0, y0, x1, y1 = span["bbox"]
                if y0 > page_h * 0.90 and FOOTER_RE.match(txt.strip()):
                    continue
                xc = (x0 + x1) / 2.0
                col = 0 if xc < mid_x else 1
                col_spans[col].append(
                    {
                        "x0": x0,
                        "y0": y0,
                        "x1": x1,
                        "y1": y1,
                        "yc": (y0 + y1) / 2.0,
                        "text": txt,
                        "color": span.get("color", 0),
                    }
                )

    result: dict[int, list[dict[str, Any]]] = {0: [], 1: []}
    for col in (0, 1):
        spans = sorted(col_spans[col], key=lambda s: (s["yc"], s["x0"]))
        clusters: list[list[dict[str, Any]]] = []
        for sp in spans:
            if not clusters:
                clusters.append([sp])
                continue
            cur = clusters[-1]
            mean_yc = sum(c["yc"] for c in cur) / len(cur)
            if abs(sp["yc"] - mean_yc) <= 4.5:
                cur.append(sp)
            else:
                clusters.append([sp])
        for cl in clusters:
            cl.sort(key=lambda s: s["x0"])
            parts: list[str] = []
            prev_x1: float | None = None
            for s in cl:
                if prev_x1 is not None and s["x0"] - prev_x1 > 1.5:
                    parts.append(" ")
                parts.append(s["text"])
                prev_x1 = s["x1"]
            line_text = "".join(parts).strip()
            if not line_text:
                continue
            result[col].append(
                {
                    "x0": min(s["x0"] for s in cl),
                    "y0": min(s["y0"] for s in cl),
                    "x1": max(s["x1"] for s in cl),
                    "y1": max(s["y1"] for s in cl),
                    "yc": sum(s["yc"] for s in cl) / len(cl),
                    "text": line_text,
                }
            )
    return result


def collect_box_rects(page: fitz.Page) -> list[fitz.Rect]:
    """Collect visible drawn rectangle borders likely enclosing <보기> or code boxes."""
    rects: list[fitz.Rect] = []
    for d in page.get_drawings():
        if not is_visible_drawing(d):
            continue
        r = d.get("rect")
        if r is None:
            continue
        if r.width >= 60 and r.height >= 25:
            rects.append(fitz.Rect(r))
    return rects


def is_inside_any_box(x0: float, yc: float, boxes: list[fitz.Rect]) -> bool:
    """Return True if point is strictly inside a large drawn box."""
    for b in boxes:
        if (b.x0 + 2.0) < x0 < (b.x1 - 2.0) and (b.y0 + 2.0) < yc < (b.y1 - 2.0):
            return True
    return False


def scan_gamrisa_pdf(path: Path) -> dict[str, Any]:
    """Inspect a single Gamrisa PDF for health, fonts, answers, and cross-page splits."""
    doc = fitz.open(path)
    total_chars = 0
    hangul_chars = 0
    replacement_chars = 0
    unique_fonts: dict[str, str] = {}
    annot_count = 0
    nonblack_option_hits: list[dict[str, Any]] = []
    answer_keyword_pages: list[int] = []
    page_texts: list[str] = []

    # Strip-level quick question tracking
    expected_q = 1
    current_q: int | None = None
    cross_column_qs: list[dict[str, Any]] = []
    cross_page_qs: list[dict[str, Any]] = []
    q_segments: dict[int, list[tuple[int, int, float, float]]] = {}

    for pno in range(len(doc)):
        page = doc[pno]
        txt = page.get_text("text")
        page_texts.append(txt)
        total_chars += len(txt)
        hangul_chars += len(HANGUL_RE.findall(txt))
        replacement_chars += txt.count("\ufffd")

        if any(kw in txt for kw in ("정답", "답안지" if pno > 0 else "정답표", "모범답안")):
            answer_keyword_pages.append(pno + 1)

        for f in page.get_fonts(full=True):
            # (xref, ext, type, basefont, name, encoding, referencer)
            ext = f[1]
            basefont = f[3]
            if basefont not in unique_fonts or unique_fonts[basefont] == "n/a":
                unique_fonts[basefont] = ext

        annots = list(page.annots() or [])
        annot_count += len(annots)

        tdict = page.get_text("dict")
        for b in tdict.get("blocks", []):
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                for sp in ln.get("spans", []):
                    st = sp.get("text", "")
                    color = sp.get("color", 0)
                    if color not in (0, 0x000000) and any(ch in CIRCLED_SET for ch in st):
                        nonblack_option_hits.append(
                            {
                                "page": pno + 1,
                                "color": hex(color),
                                "text": st[:40],
                            }
                        )

        # Skip cover page (page 0 if contains 수험자 유의사항)
        if pno == 0 and ("수험자 유의사항" in txt or "자격검정" in txt):
            continue

        mid_x = detect_mid_x(page)
        col_lines = extract_sorted_lines(page, mid_x)
        boxes = collect_box_rects(page)
        imgs = page.get_image_info(xrefs=True)
        drawings = page.get_drawings()

        for col in (0, 1):
            lines = col_lines[col]
            if not lines:
                continue
            if len(lines) == 1 and "비워둔 페이지" in lines[0]["text"]:
                continue

            # Find sequential question starts in this strip
            anchors: list[tuple[int, float, int]] = []  # (q_num, y0, line_idx)
            for idx, ln in enumerate(lines):
                m = Q_START_RE.match(ln["text"])
                if not m:
                    continue
                qnum = int(m.group(1))
                if qnum != expected_q:
                    continue
                margin_ok = (ln["x0"] <= 105.0) if col == 0 else (mid_x - 5.0 <= ln["x0"] <= mid_x + 85.0)
                if not margin_ok:
                    continue
                if is_inside_any_box(ln["x0"], ln["yc"], boxes):
                    continue
                anchors.append((qnum, ln["y0"], idx))
                expected_q += 1

            # Check Band 0 continuation above first anchor
            first_y = anchors[0][1] if anchors else page.rect.height
            # Exclude subject header box at top of col 0
            cont_lines = [
                ln for ln in lines
                if ln["y0"] < first_y - 2.0
                and not (col == 0 and ln["y0"] < 145.0 and any(
                    subj in ln["text"].replace(" ", "")
                    for subj in ("감리및사업관리", "소프트웨어공학", "데이터베이스", "시스템구조", "보안")
                ))
            ]
            # Also check if there are images or non-trivial drawings in Band 0
            band0_imgs = [
                im for im in imgs
                if (
                    ((im["bbox"][0] + im["bbox"][2]) / 2.0 < mid_x) == (col == 0)
                    and ((im["bbox"][1] + im["bbox"][3]) / 2.0) < first_y - 2.0
                    and im.get("width", 0) >= 20
                    and im.get("height", 0) >= 20
                )
            ]
            band0_draws = [
                d for d in drawings
                if is_visible_drawing(d)
                and d.get("rect") is not None
                and ((d["rect"].x0 + d["rect"].x1) / 2.0 < mid_x) == (col == 0)
                and 120.0 < ((d["rect"].y0 + d["rect"].y1) / 2.0) < first_y - 2.0
                and d["rect"].width < 0.48 * page.rect.width
                and d["rect"].height > 5.0
            ]

            if current_q is not None and (cont_lines or band0_imgs or band0_draws):
                # Continuation from previous strip!
                prev_page, prev_col, _, _ = q_segments[current_q][-1]
                q_segments[current_q].append((pno + 1, col, 40.0, first_y))
                has_visual = bool(band0_imgs or len(band0_draws) >= 2)
                info = {
                    "question": current_q,
                    "from_page": prev_page,
                    "from_col": prev_col,
                    "to_page": pno + 1,
                    "to_col": col,
                    "cont_lines": len(cont_lines),
                    "cont_imgs": len(band0_imgs),
                    "cont_draws": len(band0_draws),
                    "has_visual_in_cont": has_visual,
                    "preview": " | ".join(ln["text"][:40] for ln in cont_lines[:2]),
                }
                if prev_page != pno + 1:
                    cross_page_qs.append(info)
                elif prev_col != col:
                    cross_column_qs.append(info)

            for i, (qnum, qy0, _) in enumerate(anchors):
                qy1 = anchors[i + 1][1] if i + 1 < len(anchors) else page.rect.height - 40.0
                q_segments.setdefault(qnum, []).append((pno + 1, col, qy0, qy1))
                current_q = qnum

    embedded_fonts = sum(1 for ext in unique_fonts.values() if ext != "n/a")
    unembedded_fonts = sum(1 for ext in unique_fonts.values() if ext == "n/a")
    doc.close()

    return {
        "filename": path.name,
        "size_bytes": path.stat().st_size,
        "md5": md5_file(path),
        "pages": len(page_texts),
        "total_chars": total_chars,
        "hangul_chars": hangul_chars,
        "replacement_chars": replacement_chars,
        "unique_fonts_total": len(unique_fonts),
        "embedded_fonts": embedded_fonts,
        "unembedded_fonts": unembedded_fonts,
        "font_sample": dict(list(unique_fonts.items())[:10]),
        "annotations": annot_count,
        "answer_keyword_pages": answer_keyword_pages,
        "nonblack_option_hits": nonblack_option_hits[:10],
        "questions_detected_seq": expected_q - 1,
        "cross_column_questions": cross_column_qs,
        "cross_page_questions": cross_page_qs,
        "_page_texts": page_texts,
    }


def classify_pe_filename(name: str) -> str:
    """Classify PE PDF into 정보관리, 컴응, 정보통신, or 기타."""
    if "정보관리" in name:
        return "정보관리"
    if "컴퓨터시스템응용" in name or "컴퓨터응용시스템" in name:
        return "컴응"
    if "정보통신기술사" in name:
        return "정보통신"
    return "기타"


def scan_pe_pdf(path: Path) -> dict[str, Any]:
    """Inspect a single PE PDF for page count and text extractability."""
    doc = fitz.open(path)
    total_chars = 0
    hangul_chars = 0
    replacement_chars = 0
    unique_fonts: dict[str, str] = {}
    pages = len(doc)
    for page in doc:
        txt = page.get_text("text")
        total_chars += len(txt)
        hangul_chars += len(HANGUL_RE.findall(txt))
        replacement_chars += txt.count("\ufffd")
        for f in page.get_fonts(full=True):
            basefont, ext = f[3], f[1]
            if basefont not in unique_fonts or unique_fonts[basefont] == "n/a":
                unique_fonts[basefont] = ext
    doc.close()
    return {
        "filename": path.name,
        "category": classify_pe_filename(path.name),
        "size_bytes": path.stat().st_size,
        "md5": md5_file(path),
        "pages": pages,
        "total_chars": total_chars,
        "hangul_chars": hangul_chars,
        "replacement_chars": replacement_chars,
        "embedded_fonts": sum(1 for e in unique_fonts.values() if e != "n/a"),
        "unembedded_fonts": sum(1 for e in unique_fonts.values() if e == "n/a"),
    }


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    gamrisa_files = sorted(GAMRISA_DIR.iterdir())
    pe_files = sorted(PE_DIR.iterdir())

    gamrisa_exts = Counter(p.suffix.lower() for p in gamrisa_files if p.is_file())
    pe_exts = Counter(p.suffix.lower() for p in pe_files if p.is_file())

    gamrisa_results: list[dict[str, Any]] = []
    texts_2017: list[tuple[str, list[str]]] = []

    for f in gamrisa_files:
        if f.is_file() and f.suffix.lower() == ".pdf":
            res = scan_gamrisa_pdf(f)
            if "2017년" in f.name:
                texts_2017.append((f.name, res["_page_texts"]))
            res.pop("_page_texts", None)
            gamrisa_results.append(res)

    dup_2017: dict[str, Any] = {}
    if len(texts_2017) == 2:
        (n1, t1), (n2, t2) = texts_2017
        joined1 = "\n".join(t1)
        joined2 = "\n".join(t2)
        ratio = difflib.SequenceMatcher(None, joined1, joined2).ratio()
        diff_lines = list(
            difflib.unified_diff(
                joined1.splitlines(),
                joined2.splitlines(),
                fromfile=n1,
                tofile=n2,
                n=1,
            )
        )
        dup_2017 = {
            "file1": n1,
            "file2": n2,
            "similarity_ratio": round(ratio, 6),
            "diff_line_count": len(diff_lines),
            "diff_sample": diff_lines[:30],
        }

    pe_results = [
        scan_pe_pdf(f)
        for f in pe_files
        if f.is_file() and f.suffix.lower() == ".pdf"
    ]
    pe_categories = Counter(r["category"] for r in pe_results)

    report = {
        "folders": {
            "gamrisa": {
                "path": str(GAMRISA_DIR),
                "file_count": len(gamrisa_files),
                "extensions": dict(gamrisa_exts),
            },
            "pe": {
                "path": str(PE_DIR),
                "file_count": len(pe_files),
                "extensions": dict(pe_exts),
                "category_counts": dict(pe_categories),
            },
        },
        "gamrisa_2017_comparison": dup_2017,
        "gamrisa_pdfs": gamrisa_results,
        "pe_pdfs": pe_results,
    }

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Print concise human-readable summary
    print(f"[감리사 폴더] {len(gamrisa_files)} files, extensions={dict(gamrisa_exts)}")
    for r in gamrisa_results:
        print(
            f"  - {r['filename']} | {r['pages']}p | hangul={r['hangul_chars']} | "
            f"emb={r['embedded_fonts']}/{r['unique_fonts_total']} | Q={r['questions_detected_seq']} | "
            f"xcol={len(r['cross_column_questions'])} | xpage={len(r['cross_page_questions'])}"
        )
    if dup_2017:
        print(f"[2017 비교] similarity={dup_2017['similarity_ratio']}, diff_lines={dup_2017['diff_line_count']}")
    print(f"\n[기술사 폴더] {len(pe_files)} files, extensions={dict(pe_exts)}, categories={dict(pe_categories)}")
    bad_pe = [r for r in pe_results if r["hangul_chars"] < 100 or r["replacement_chars"] > 0]
    print(f"  PE low-hangul/replacement files: {len(bad_pe)}")
    print(f"Saved full report to {REPORT_PATH}")


if __name__ == "__main__":
    main()
