"""Parse Gamrisa (정보시스템감리사) past exam PDFs and crop figure/table/diagram questions."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import pymupdf as fitz
from PIL import Image, ImageDraw

GAMRISA_DIR = Path("정보시스템감리사")
DEFAULT_OUT = Path("data/gamrisa_raw.json")
DEFAULT_DIAG_OUT = Path("data/gamrisa_diag.json")
DEFAULT_IMG_DIR = Path("web/assets/images")

CANONICAL_SUBJECTS = {
    "감리및사업관리": "감리 및 사업관리",
    "소프트웨어공학": "소프트웨어 공학",
    "데이터베이스": "데이터베이스",
    "시스템구조": "시스템 구조",
    "보안": "보안",
}

Q_START_RE = re.compile(r"^\s*(\d{1,3})\s*\.\s*(.*)")
FOOTER_RE = re.compile(r"^\s*-\s*\d+\s*-\s*$")
SHARED_PASSAGE_RE = re.compile(r"※.*?(\d{1,3})\s*번?\s*[~\-～]\s*(\d{1,3})\s*번?")

MARKERS_PRIMARY = ("①", "②", "③", "④")
MARKERS_ALT = ("➀", "➁", "➂", "➃")
ALT_TO_PRIMARY = dict(zip(MARKERS_ALT, MARKERS_PRIMARY))
MARKER_TO_NUM = {
    "①": "1", "②": "2", "③": "3", "④": "4",
    "➀": "1", "➁": "2", "➂": "3", "➃": "4",
}

VISUAL_HINT_KEYWORDS = ("그림", "다이어그램", "표", "차트", "그래프", "도표", "진리표", "오분류표")


def canonical_subject_for_number(num: int) -> str:
    """Return canonical subject by Gamrisa question number."""
    if num <= 25:
        return "감리 및 사업관리"
    if num <= 50:
        return "소프트웨어 공학"
    if num <= 75:
        return "데이터베이스"
    if num <= 100:
        return "시스템 구조"
    return "보안"


def parse_filename_meta(path: Path) -> tuple[int, int, str]:
    """Extract (year, round_num, year_round_label) from filename."""
    m = re.search(r"(\d{4})\s*년\s*\(\s*제\s*(\d+)\s*회\s*\)", path.name)
    if not m:
        raise ValueError(f"Cannot extract year/round from filename: {path.name}")
    year = int(m.group(1))
    rnd = int(m.group(2))
    return year, rnd, f"{year}년(제{rnd}회)"


def is_visible_drawing(d: dict[str, Any]) -> bool:
    """Return True if drawing has a visible stroke or non-white fill."""
    color = d.get("color")
    fill = d.get("fill")
    has_stroke = color is not None and color != (1.0, 1.0, 1.0)
    has_fill = fill is not None and fill != (1.0, 1.0, 1.0)
    return has_stroke or has_fill


def detect_mid_x(page: fitz.Page) -> float:
    """Detect center vertical column divider x-coordinate or fallback to half page width."""
    w = page.rect.width
    h = page.rect.height
    candidates: list[tuple[float, float, float]] = []
    for d in page.get_drawings():
        if not is_visible_drawing(d):
            continue
        r = d.get("rect")
        if r is None:
            continue
        xc = (r.x0 + r.x1) / 2.0
        if 0.48 * w <= xc <= 0.52 * w and r.height > 0.30 * h and r.width <= 3.0:
            candidates.append((abs(xc - w / 2.0), -r.height, xc))
    if candidates:
        candidates.sort()
        return candidates[0][2]
    return w / 2.0


def extract_column_lines(page: fitz.Page, mid_x: float) -> dict[int, list[dict[str, Any]]]:
    """Cluster text spans into coordinate-sorted visual lines per column (0=left, 1=right)."""
    page_h = page.rect.height
    col_spans: dict[int, list[dict[str, Any]]] = {0: [], 1: []}
    tdict = page.get_text("dict")
    for block in tdict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                raw = span.get("text", "")
                if not raw.strip():
                    continue
                x0, y0, x1, y1 = span["bbox"]
                if y0 > page_h * 0.90 and FOOTER_RE.match(raw.strip()):
                    continue
                if "편집의도에 따라 비워둔 페이지임" in raw:
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
                        "text": raw,
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
            cur_y0 = min(c["y0"] for c in cur)
            cur_y1 = max(c["y1"] for c in cur)
            min_h = max(1.0, min(cur_y1 - cur_y0, sp["y1"] - sp["y0"]))
            v_overlap = min(cur_y1, sp["y1"]) - max(cur_y0, sp["y0"])
            if abs(sp["yc"] - mean_yc) <= 4.5 or v_overlap >= 0.50 * min_h:
                cur.append(sp)
            else:
                clusters.append([sp])

        for cl in clusters:
            cl.sort(key=lambda s: s["x0"])
            parts: list[str] = []
            prev_x1: float | None = None
            for s in cl:
                txt = s["text"].replace("\xa0", " ")
                if prev_x1 is not None:
                    gap = s["x0"] - prev_x1
                    if gap > 15.0:
                        parts.append("  ")
                    elif gap > 1.5 and not (parts and parts[-1].endswith(" ")) and not txt.startswith(" "):
                        parts.append(" ")
                parts.append(txt)
                prev_x1 = s["x1"]
            line_text = "".join(parts).strip()
            if not line_text or "편집의도에 따라 비워둔 페이지" in line_text:
                continue
            result[col].append(
                {
                    "x0": min(s["x0"] for s in cl),
                    "y0": min(s["y0"] for s in cl),
                    "x1": max(s["x1"] for s in cl),
                    "y1": max(s["y1"] for s in cl),
                    "yc": sum(s["yc"] for s in cl) / len(cl),
                    "text": line_text,
                    "spans": cl,
                }
            )
    return result


def filter_page_drawings(
    page: fitz.Page, mid_x: float, subject_line_rects: list[fitz.Rect]
) -> dict[int, list[dict[str, Any]]]:
    """Filter visible body drawings and assign them to col 0 or col 1."""
    w = page.rect.width
    h = page.rect.height
    by_col: dict[int, list[dict[str, Any]]] = {0: [], 1: []}

    for d in page.get_drawings():
        if not is_visible_drawing(d):
            continue
        r = d.get("rect")
        if r is None:
            continue
        rect = fitz.Rect(r)
        if rect.width > 0.85 * w or rect.height > 0.85 * h:
            continue
        xc = (rect.x0 + rect.x1) / 2.0
        # Center vertical divider
        if 0.48 * w <= xc <= 0.52 * w and rect.height > 0.30 * h and rect.width <= 3.0:
            continue
        # Subject header box near top of col 0
        if rect.y0 < 150.0 and xc < mid_x:
            if any(rect.intersects(sr) for sr in subject_line_rects):
                continue
            if rect.width >= 60.0 and rect.height <= 45.0 and rect.y1 < 135.0:
                # Double-check against subject text y-band if subject header exists on page
                if subject_line_rects:
                    continue
        # Ignore footer underlines/page rules if any near bottom margin
        if rect.y0 > h * 0.92:
            continue

        col = 0 if xc < mid_x else 1
        by_col[col].append({"rect": rect, "drawing": d})
    return by_col


def filter_page_images(page: fitz.Page, mid_x: float) -> dict[int, list[fitz.Rect]]:
    """Collect significant raster image bounding boxes per column."""
    by_col: dict[int, list[fitz.Rect]] = {0: [], 1: []}
    for im in page.get_image_info(xrefs=True):
        bbox = im.get("bbox")
        if not bbox:
            continue
        rect = fitz.Rect(bbox)
        if rect.width < 18.0 or rect.height < 14.0:
            continue
        if im.get("width", 0) < 15 or im.get("height", 0) < 15:
            continue
        xc = (rect.x0 + rect.x1) / 2.0
        col = 0 if xc < mid_x else 1
        by_col[col].append(rect)
    return by_col


def collect_box_rects(drawings: list[dict[str, Any]]) -> list[fitz.Rect]:
    """Collect closed rectangular borders that enclose <보기> or code/table blocks."""
    rects: list[fitz.Rect] = []
    for item in drawings:
        r = item["rect"]
        if r.width >= 55.0 and r.height >= 22.0:
            rects.append(r)
    return rects


def is_inside_any_box(x0: float, yc: float, boxes: list[fitz.Rect]) -> bool:
    """Return True if point is strictly inside a drawn rectangle."""
    for b in boxes:
        if (b.x0 + 2.0) < x0 < (b.x1 - 2.0) and (b.y0 + 2.0) < yc < (b.y1 - 2.0):
            return True
    return False


def _cluster_coords(vals: list[float], tol: float = 4.0) -> list[float]:
    """Cluster 1D coordinates within tolerance."""
    if not vals:
        return []
    vals_s = sorted(vals)
    groups = [[vals_s[0]]]
    for v in vals_s[1:]:
        if v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g) / len(g) for g in groups]


def _is_plain_single_frame(drawings: list[dict[str, Any]], lines: list[dict[str, Any]]) -> bool:
    """Return True if drawings only form a plain single-cell <보기>/code frame (optionally with a top '보기' bar)."""
    if not drawings:
        return True
    all_x0 = min(d["rect"].x0 for d in drawings)
    all_y0 = min(d["rect"].y0 for d in drawings)
    all_x1 = max(d["rect"].x1 for d in drawings)
    all_y1 = max(d["rect"].y1 for d in drawings)
    frame_w = max(1.0, all_x1 - all_x0)
    frame_h = max(1.0, all_y1 - all_y0)

    inner_h_lines: list[float] = []
    inner_v_lines: list[float] = []

    for item in drawings:
        d = item["drawing"]
        r = item["rect"]
        for it in d.get("items", []):
            kind = it[0]
            if kind == "c":
                # Check if Bezier curve is larger than a tiny rounded corner
                pts = [p for p in it[1:] if hasattr(p, "x")]
                if pts:
                    cw = max(p.x for p in pts) - min(p.x for p in pts)
                    ch = max(p.y for p in pts) - min(p.y for p in pts)
                    if cw > 8.0 or ch > 8.0:
                        return False
            elif kind == "qu":
                return False
            elif kind == "l":
                p1, p2 = it[1], it[2]
                dx = abs(p1.x - p2.x)
                dy = abs(p1.y - p2.y)
                if dx > 2.5 and dy > 2.5:
                    return False
                if dy <= 2.5 and dx >= 15.0:
                    ym = (p1.y + p2.y) / 2.0
                    if (all_y0 + 6.0) < ym < (all_y1 - 6.0):
                        inner_h_lines.append(ym)
                elif dx <= 2.5 and dy >= 10.0:
                    xm = (p1.x + p2.x) / 2.0
                    if (all_x0 + 6.0) < xm < (all_x1 - 6.0):
                        inner_v_lines.append(xm)
            elif kind == "re":
                rr = it[1]
                # Multiple distinct non-overlapping rectangles -> not a single frame
                if rr.width < frame_w - 8.0 or rr.height < frame_h - 8.0:
                    if rr.width >= 10.0 and rr.height >= 10.0:
                        return False

    if inner_v_lines:
        return False

    h_clusters = _cluster_coords(inner_h_lines, tol=5.0)
    if len(h_clusters) == 0:
        return True
    if len(h_clusters) == 1:
        # Allow a single top header line only if above it is just "보기" / "<보기>"
        hy = h_clusters[0]
        if hy - all_y0 <= 32.0:
            header_texts = [
                ln["text"].replace(" ", "").strip("<>[]")
                for ln in lines
                if (all_y0 - 3.0) <= ln["yc"] <= (hy + 2.0)
            ]
            if not header_texts or all(t in ("보기", "") for t in header_texts):
                return True
        return False
    return False


def analyze_segment_visuals(
    page: fitz.Page,
    seg_rect: fitz.Rect,
    seg_images: list[fitz.Rect],
    seg_drawings: list[dict[str, Any]],
    seg_lines: list[dict[str, Any]],
) -> list[str]:
    """Detect whether a question segment contains raster images, tables, or vector diagrams."""
    reasons: list[str] = []

    if seg_images:
        reasons.append(f"raster_image({len(seg_images)})")

    # Drop text underlines (thin short horizontal strokes right under a text line)
    def _is_underline(item: dict[str, Any]) -> bool:
        r = item["rect"]
        if r.height > 2.0 or r.width > 150.0:
            return False
        return any(-3.0 <= r.y0 - ln["y1"] <= 4.0 and r.x0 >= ln["x0"] - 3 and r.x1 <= ln["x1"] + 3
                   for ln in seg_lines)

    seg_drawings = [d for d in seg_drawings if not _is_underline(d)]

    # Pure-geometry vector drawing analysis (find_tables is too slow / leaks across questions)
    if seg_drawings:
        has_curve = False
        has_diag = False
        cell_rects: list[fitz.Rect] = []
        h_ys: list[float] = []
        v_xs: list[float] = []
        non_frame_prims = 0

        for item in seg_drawings:
            d = item["drawing"]
            r = item["rect"]
            if r.width >= 10.0 and r.height >= 8.0:
                cell_rects.append(r)
            for it in d.get("items", []):
                kind = it[0]
                if kind == "c":
                    pts = [p for p in it[1:] if hasattr(p, "x")]
                    if pts:
                        cw = max(p.x for p in pts) - min(p.x for p in pts)
                        ch = max(p.y for p in pts) - min(p.y for p in pts)
                        if cw > 8.0 or ch > 8.0:
                            has_curve = True
                elif kind == "qu":
                    has_diag = True
                elif kind == "l":
                    p1, p2 = it[1], it[2]
                    dx = abs(p1.x - p2.x)
                    dy = abs(p1.y - p2.y)
                    if dx > 2.5 and dy > 2.5:
                        has_diag = True
                    elif dy <= 2.5 and dx >= 12.0:
                        h_ys.append((p1.y + p2.y) / 2.0)
                    elif dx <= 2.5 and dy >= 8.0:
                        v_xs.append((p1.x + p2.x) / 2.0)
                elif kind == "re":
                    rr = it[1]
                    h_ys.extend([rr.y0, rr.y1])
                    v_xs.extend([rr.x0, rr.x1])

            if r.width < 120.0 or r.height < 60.0:
                non_frame_prims += 1

        if has_curve:
            reasons.append("vector_curve")
        if has_diag:
            reasons.append("vector_diagonal_or_arrow")

        # Grid / multi-cell table check from drawing primitives
        uniq_x = _cluster_coords(v_xs, tol=5.0)
        uniq_y = _cluster_coords(h_ys, tol=5.0)
        if not any(r.startswith("table") for r in reasons):
            if len(uniq_x) >= 3 and len(uniq_y) >= 3:
                reasons.append(f"drawing_grid({len(uniq_y)-1}x{len(uniq_x)-1})")
            elif len(cell_rects) >= 4:
                xs_c = _cluster_coords([(c.x0 + c.x1) / 2.0 for c in cell_rects], tol=8.0)
                ys_c = _cluster_coords([(c.y0 + c.y1) / 2.0 for c in cell_rects], tol=8.0)
                if len(xs_c) >= 2 or len(ys_c) >= 3:
                    reasons.append(f"cell_grid({len(ys_c)}x{len(xs_c)})")

        if not reasons and not _is_plain_single_frame(seg_drawings, seg_lines):
            if len(seg_drawings) >= 3 or non_frame_prims >= 3:
                reasons.append(f"vector_diagram({len(seg_drawings)})")

    # Deduplicate while preserving order
    return list(dict.fromkeys(reasons))


def clean_text_lines(lines: list[str]) -> str:
    """Join wrapped Korean/English lines cleanly while preserving deliberate breaks."""
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
        # Rejoin hyphenated English word wraps like "Perfor-" + "mance" or "speci-" + "alization"
        if prev.endswith("-") and len(prev) >= 2 and prev[-2].isalpha() and s[0].isalpha():
            out[-1] = prev[:-1] + s
        elif prev.endswith(("다.", "?", "!", ":", ")", "]")) or s.startswith(("-", "Ÿ", "•", "·", "가.", "나.", "다.", "라.", "마.", "바.", "<")):
            out.append(s)
        else:
            out[-1] = prev + " " + s
    return "\n".join(out).strip()


def _extract_markers_from_spans(line: dict[str, Any], marker_set: tuple[str, ...]) -> list[tuple[str, float, int]]:
    """Find (marker_char, x_pos, char_idx_in_line) occurrences in a line."""
    # Reconstruct character positions cleanly using spans for accurate x0
    hits: list[tuple[str, float, int]] = []
    text = line["text"]
    for idx, ch in enumerate(text):
        if ch in marker_set:
            # Find matching span x0 approximately by searching spans
            mx = line["x0"]
            acc = 0
            for sp in line["spans"]:
                st = sp["text"].replace("\xa0", " ")
                pos = st.find(ch)
                if pos != -1:
                    # Estimate x0 proportionally inside span if multiple chars
                    frac = pos / max(1, len(st))
                    mx = sp["x0"] + frac * (sp["x1"] - sp["x0"])
                    break
            hits.append((ch, mx, idx))
    return hits


def _choose_marker_sequence(
    lines: list[dict[str, Any]],
    boxes: list[fitz.Rect],
    marker_set: tuple[str, ...],
) -> tuple[int, dict[str, tuple[int, float]]] | None:
    """Locate the start line index and positions of options 1..4."""
    # Prefer markers outside boxes first; if incomplete, allow inside boxes
    for allow_boxed in (False, True):
        # Collect all marker hits in reading order
        all_hits: list[tuple[str, int, float, int]] = []  # (num_str, line_idx, x_pos, char_idx)
        for li, ln in enumerate(lines):
            hits = _extract_markers_from_spans(ln, marker_set)
            for ch, mx, cidx in hits:
                if not allow_boxed and is_inside_any_box(mx, ln["yc"], boxes):
                    continue
                all_hits.append((MARKER_TO_NUM[ch], li, mx, cidx))

        # Find the last valid subsequence containing 1, 2, 3, 4 in order
        starts_1 = [i for i, h in enumerate(all_hits) if h[0] == "1"]
        for s_idx in reversed(starts_1):
            found: dict[str, tuple[int, float]] = {}
            cur_expect = 1
            for h in all_hits[s_idx:]:
                if h[0] == str(cur_expect):
                    found[h[0]] = (h[1], h[2])
                    cur_expect += 1
                    if cur_expect == 5:
                        break
            if len(found) == 4:
                return found["1"][0], found
    return None


def split_question_and_options(
    lines: list[dict[str, Any]],
    boxes: list[fitz.Rect],
    q_num: int,
) -> tuple[str, dict[str, str]]:
    """Split a question's coordinate-sorted lines into question stem and 4 options."""
    if not lines:
        return "", {"1": "", "2": "", "3": "", "4": ""}

    # Strip leading "<q_num>." from first line
    first_text = lines[0]["text"]
    m = Q_START_RE.match(first_text)
    cleaned_lines = [dict(ln) for ln in lines]
    if m and int(m.group(1)) == q_num:
        cleaned_lines[0]["text"] = m.group(2).strip()

    chosen = _choose_marker_sequence(cleaned_lines, boxes, MARKERS_PRIMARY)
    active_markers = MARKERS_PRIMARY
    if chosen is None:
        chosen = _choose_marker_sequence(cleaned_lines, boxes, MARKERS_ALT)
        active_markers = MARKERS_ALT

    if chosen is None:
        stem = clean_text_lines([ln["text"] for ln in cleaned_lines])
        return stem, {"1": "", "2": "", "3": "", "4": ""}

    opt_start_line, found_map = chosen
    stem_lines = [ln["text"] for ln in cleaned_lines[:opt_start_line]]

    # Check if text exists BEFORE the marker ① on opt_start_line
    first_opt_line = cleaned_lines[opt_start_line]
    m1_char = active_markers[0]
    pos1 = first_opt_line["text"].find(m1_char)
    if pos1 > 0:
        prefix = first_opt_line["text"][:pos1].strip()
        if prefix:
            stem_lines.append(prefix)

    # Parse option lines from opt_start_line onward
    opt_parts: dict[str, list[str]] = {"1": [], "2": [], "3": [], "4": []}
    active_row_markers: list[tuple[str, float]] = []  # [(num_str, x0)]

    for li in range(opt_start_line, len(cleaned_lines)):
        ln = cleaned_lines[li]
        txt = ln["text"]
        if li == opt_start_line and pos1 > 0:
            txt = txt[pos1:]

        hits = [
            (MARKER_TO_NUM[ch], mx, idx)
            for idx, ch in enumerate(txt)
            if ch in active_markers
            for mx in [
                next(
                    (
                        sp["x0"]
                        for sp in ln["spans"]
                        if ch in sp["text"].replace("\xa0", " ")
                    ),
                    ln["x0"],
                )
            ]
        ]

        if hits:
            # Sort hits by character index
            hits.sort(key=lambda h: h[2])
            active_row_markers = [(h[0], h[1]) for h in hits]
            for idx_h, (num_s, _, char_i) in enumerate(hits):
                end_i = hits[idx_h + 1][2] if idx_h + 1 < len(hits) else len(txt)
                seg_txt = txt[char_i + 1 : end_i].strip()
                if seg_txt:
                    opt_parts[num_s].append(seg_txt)
        else:
            # Continuation line for active_row_markers
            if len(active_row_markers) == 1:
                num_s = active_row_markers[0][0]
                if txt.strip():
                    opt_parts[num_s].append(txt.strip())
            elif len(active_row_markers) >= 2:
                # Multi-column grid continuation: split spans by midpoint between marker x's
                sorted_cols = sorted(active_row_markers, key=lambda x: x[1])
                buckets: dict[str, list[str]] = {n: [] for n, _ in sorted_cols}
                for sp in ln["spans"]:
                    st = sp["text"].strip()
                    if not st:
                        continue
                    best_num = sorted_cols[0][0]
                    for col_idx in range(len(sorted_cols) - 1):
                        mid_split = (sorted_cols[col_idx][1] + sorted_cols[col_idx + 1][1]) / 2.0
                        # Use left bias because option text starts right of marker
                        if sp["x0"] >= sorted_cols[col_idx + 1][1] - 12.0:
                            best_num = sorted_cols[col_idx + 1][0]
                        elif sp["x0"] >= mid_split + 10.0:
                            best_num = sorted_cols[col_idx + 1][0]
                    buckets[best_num].append(st)
                for num_s, toks in buckets.items():
                    joined = " ".join(toks).strip()
                    if joined:
                        opt_parts[num_s].append(joined)

    question_text = clean_text_lines(stem_lines)
    options = {k: clean_text_lines(v) for k, v in opt_parts.items()}
    return question_text, options


def render_question_crop(
    doc: fitz.Document,
    segments: list[dict[str, Any]],
    out_path: Path,
    dpi: int = 250,
) -> tuple[int, int]:
    """Render and vertically stitch question segments into a single PNG."""
    pil_segments: list[Image.Image] = []
    for seg in segments:
        page = doc[seg["page_idx"]]
        mid_x = seg["mid_x"]
        page_w = page.rect.width
        col = seg["col"]
        band_top = seg["band_top"]
        band_bottom = seg["band_bottom"]

        objs_x0: list[float] = []
        objs_y0: list[float] = []
        objs_x1: list[float] = []
        objs_y1: list[float] = []

        for ln in seg["lines"]:
            objs_x0.append(ln["x0"])
            objs_y0.append(ln["y0"])
            objs_x1.append(ln["x1"])
            objs_y1.append(ln["y1"])
        for im_r in seg["images"]:
            objs_x0.append(im_r.x0)
            objs_y0.append(im_r.y0)
            objs_x1.append(im_r.x1)
            objs_y1.append(im_r.y1)
        for dr in seg["drawings"]:
            r = dr["rect"]
            objs_x0.append(r.x0)
            objs_y0.append(r.y0)
            objs_x1.append(r.x1)
            objs_y1.append(r.y1)

        if not objs_x0:
            continue

        y0 = max(band_top + 1.0, min(objs_y0) - 6.0)
        y1 = min(band_bottom - 1.0, max(objs_y1) + 6.0)
        if y1 <= y0 + 2.0:
            continue

        if col == 0:
            x0 = max(12.0, min(objs_x0) - 8.0)
            x1 = min(mid_x - 3.0, max(objs_x1) + 8.0)
        else:
            x0 = max(mid_x + 3.0, min(objs_x0) - 8.0)
            x1 = min(page_w - 12.0, max(objs_x1) + 8.0)

        if x1 <= x0 + 2.0:
            continue

        clip = fitz.Rect(x0, y0, x1, y1)
        pix = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        pil_segments.append(img)

    if not pil_segments:
        raise ValueError(f"No renderable segments for {out_path}")

    if len(pil_segments) == 1:
        final_img = pil_segments[0]
    else:
        gap = 16
        target_w = max(im.width for im in pil_segments)
        total_h = sum(im.height for im in pil_segments) + gap * (len(pil_segments) - 1)
        final_img = Image.new("RGB", (target_w, total_h), (255, 255, 255))
        draw = ImageDraw.Draw(final_img)
        cur_y = 0
        for idx, im in enumerate(pil_segments):
            final_img.paste(im, (0, cur_y))
            cur_y += im.height
            if idx < len(pil_segments) - 1:
                sep_y = cur_y + gap // 2
                for dx in range(10, target_w - 10, 12):
                    draw.line([(dx, sep_y), (min(dx + 6, target_w - 10), sep_y)], fill=(195, 195, 195), width=1)
                cur_y += gap

    out_path.parent.mkdir(parents=True, exist_ok=True)
    final_img.save(out_path, format="PNG")
    return final_img.size


def parse_gamrisa_pdf(
    path: Path,
    img_dir: Path,
    save_images: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Parse one Gamrisa PDF into question records and diagnostics."""
    year, rnd, year_round = parse_filename_meta(path)
    doc = fitz.open(path)

    expected_q = 1
    current_q: int | None = None
    open_shared: tuple[int, int] | None = None  # (q_start, q_end)

    q_segments: dict[int, list[dict[str, Any]]] = defaultdict(list)
    shared_passages: list[dict[str, Any]] = []  # {q_start, q_end, segments: [...]}
    q_subject_detected: dict[int, str] = {}
    current_subject = "감리 및 사업관리"

    for pno in range(len(doc)):
        page = doc[pno]
        raw_txt = page.get_text("text")
        norm_txt = re.sub(r"\s+", "", raw_txt)
        if any(k in norm_txt for k in ("수험자유의사항", "응시자유의사항", "문제지유형", "자격검정", "답안지작성요령")):
            # Cover / instruction page: never contains real questions
            continue

        mid_x = detect_mid_x(page)
        col_lines = extract_column_lines(page, mid_x)

        # Find subject headers at top of col 0
        subject_line_rects: list[fitz.Rect] = []
        page_starts_new_subject = False
        for ln in col_lines[0]:
            if ln["y0"] < 145.0:
                norm = re.sub(r"\s+", "", ln["text"])
                if norm in CANONICAL_SUBJECTS:
                    current_subject = CANONICAL_SUBJECTS[norm]
                    subject_line_rects.append(fitz.Rect(ln["x0"], ln["y0"], ln["x1"], ln["y1"]))
                    page_starts_new_subject = True

        col_drawings = filter_page_drawings(page, mid_x, subject_line_rects)
        col_images = filter_page_images(page, mid_x)

        for col in (0, 1):
            lines = col_lines[col]
            drawings = col_drawings[col]
            images = col_images[col]
            if not lines and not drawings and not images:
                continue

            # Exclude subject header lines from body lines
            if col == 0 and subject_line_rects:
                lines = [
                    ln for ln in lines
                    if not any(
                        fitz.Rect(ln["x0"], ln["y0"], ln["x1"], ln["y1"]).intersects(sr)
                        for sr in subject_line_rects
                    )
                ]

            boxes = collect_box_rects(drawings)
            anchors: list[tuple[str, float, Any]] = []

            for ln in lines:
                sm = SHARED_PASSAGE_RE.search(ln["text"])
                if sm and not is_inside_any_box(ln["x0"], ln["yc"], boxes):
                    q1, q2 = int(sm.group(1)), int(sm.group(2))
                    if q1 == expected_q and q2 >= q1:
                        anchors.append(("shared", ln["y0"], (q1, q2)))
                        continue

                qm = Q_START_RE.match(ln["text"])
                if qm:
                    qnum = int(qm.group(1))
                    if qnum == expected_q:
                        margin_ok = (ln["x0"] <= 105.0) if col == 0 else (mid_x - 5.0 <= ln["x0"] <= mid_x + 85.0)
                        if margin_ok and not is_inside_any_box(ln["x0"], ln["yc"], boxes):
                            anchors.append(("question", ln["y0"], qnum))
                            expected_q += 1

            anchors.sort(key=lambda a: a[1])

            # Compute page vertical bounds for bands
            top_bound = 35.0
            if col == 0 and subject_line_rects:
                top_bound = max(sr.y1 for sr in subject_line_rects) + 8.0
            bottom_bound = page.rect.height - 35.0

            # Build vertical intervals: Band 0 (before first anchor) + Band i for each anchor
            bands: list[tuple[str, Any, float, float]] = []
            if anchors:
                first_y = anchors[0][1]
                # Band 0 belongs to open_shared or current_q (unless page starts a brand new subject and first anchor is at top)
                if not (col == 0 and page_starts_new_subject):
                    if open_shared is not None:
                        bands.append(("shared_cont", open_shared, top_bound, first_y))
                    elif current_q is not None:
                        bands.append(("question_cont", current_q, top_bound, first_y))
                for idx_a, (kind, ay0, payload) in enumerate(anchors):
                    ay1 = anchors[idx_a + 1][1] if idx_a + 1 < len(anchors) else bottom_bound
                    bands.append((kind, payload, ay0, ay1))
                    if kind == "shared":
                        open_shared = payload
                    elif kind == "question":
                        open_shared = None
                        current_q = payload
                        q_subject_detected[payload] = current_subject
            else:
                if open_shared is not None:
                    bands.append(("shared_cont", open_shared, top_bound, bottom_bound))
                elif current_q is not None and not (col == 0 and page_starts_new_subject):
                    bands.append(("question_cont", current_q, top_bound, bottom_bound))

            # Assign lines, images, drawings to bands
            for b_kind, b_payload, y_top, y_bot in bands:
                seg_lines = [
                    ln for ln in lines
                    if (y_top - 2.5) <= ln["yc"] < (y_bot - 2.0)
                ]
                seg_imgs = [
                    ir for ir in images
                    if (y_top - 4.0) <= ((ir.y0 + ir.y1) / 2.0) < (y_bot - 2.0)
                ]
                seg_draws = [
                    dr for dr in drawings
                    if (y_top - 4.0) <= ((dr["rect"].y0 + dr["rect"].y1) / 2.0) < (y_bot - 2.0)
                ]
                if not seg_lines and not seg_imgs and not seg_draws:
                    continue

                seg_obj = {
                    "page_idx": pno,
                    "page_num": pno + 1,
                    "col": col,
                    "mid_x": mid_x,
                    "band_top": y_top,
                    "band_bottom": y_bot,
                    "lines": seg_lines,
                    "images": seg_imgs,
                    "drawings": seg_draws,
                    "boxes": boxes,
                }

                if b_kind == "shared":
                    shared_passages.append(
                        {"q_start": b_payload[0], "q_end": b_payload[1], "segments": [seg_obj]}
                    )
                elif b_kind == "shared_cont":
                    shared_passages[-1]["segments"].append(seg_obj)
                else:
                    q_segments[b_payload].append(seg_obj)

    records: list[dict[str, Any]] = []
    diags: list[dict[str, Any]] = []

    # Map question -> shared passage object if applicable
    shared_for_q: dict[int, dict[str, Any]] = {}
    for sp in shared_passages:
        for qn in range(sp["q_start"], sp["q_end"] + 1):
            shared_for_q[qn] = sp

    for qnum in range(1, 121):
        segs = q_segments.get(qnum, [])
        sp_entry = shared_for_q.get(qnum)
        all_lines = [ln for seg in segs for ln in seg["lines"]]
        all_boxes = [b for seg in segs for b in seg["boxes"]]

        q_stem, options = split_question_and_options(all_lines, all_boxes, qnum)

        sp_text = ""
        if sp_entry is not None:
            sp_lines = [ln["text"] for seg in sp_entry["segments"] for ln in seg["lines"]]
            sp_text = clean_text_lines(sp_lines)
            if sp_text:
                q_stem = f"{sp_text}\n{q_stem}" if q_stem else sp_text

        # Visual detection across shared passage segments + question segments
        combined_segs = (sp_entry["segments"] if sp_entry else []) + segs
        visual_reasons: list[str] = []
        for seg in combined_segs:
            page = doc[seg["page_idx"]]
            col = seg["col"]
            mid_x = seg["mid_x"]
            x_min = 12.0 if col == 0 else mid_x + 2.0
            x_max = mid_x - 2.0 if col == 0 else page.rect.width - 12.0
            clip_r = fitz.Rect(x_min, seg["band_top"], x_max, seg["band_bottom"])
            seg_reasons = analyze_segment_visuals(
                page, clip_r, seg["images"], seg["drawings"], seg["lines"]
            )
            for r in seg_reasons:
                if r not in visual_reasons:
                    visual_reasons.append(r)

        has_image = len(visual_reasons) > 0
        q_id = f"gamrisa_{year}_{rnd:02d}_{qnum:03d}"
        image_path: str | None = None
        crop_size: list[int] | None = None

        if has_image:
            rel_img = f"web/assets/images/{q_id}.png"
            image_path = rel_img
            if save_images:
                w_px, h_px = render_question_crop(doc, combined_segs, img_dir / f"{q_id}.png")
                crop_size = [w_px, h_px]

        subj = canonical_subject_for_number(qnum)
        records.append(
            {
                "id": q_id,
                "year_round": year_round,
                "subject": subj,
                "number": qnum,
                "question": q_stem,
                "options": options,
                "answer": None,
                "has_image": has_image,
                "image_path": image_path,
            }
        )

        pages_used = sorted({seg["page_num"] for seg in segs})
        cols_used = [(seg["page_num"], seg["col"]) for seg in segs]
        is_cross_page = len(pages_used) > 1
        is_cross_column = len(cols_used) > 1 and not is_cross_page
        keyword_warn = (not has_image) and any(kw in q_stem for kw in VISUAL_HINT_KEYWORDS)

        diags.append(
            {
                "id": q_id,
                "number": qnum,
                "pages": pages_used,
                "segments": [{"page": s["page_num"], "col": s["col"], "lines": len(s["lines"])} for s in segs],
                "is_cross_column": is_cross_column,
                "is_cross_page": is_cross_page,
                "has_shared_passage": sp_entry is not None,
                "has_image": has_image,
                "visual_reasons": visual_reasons,
                "crop_size": crop_size,
                "visual_keyword_warning": keyword_warn,
            }
        )

    doc.close()
    return records, diags


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Parse Gamrisa exam PDFs and crop visual questions.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--file", type=Path, help="Single PDF file to parse.")
    group.add_argument("--all", action="store_true", help="Parse all PDFs in 정보시스템감리사/.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output JSON path.")
    parser.add_argument("--diag-out", type=Path, default=DEFAULT_DIAG_OUT, help="Output diagnostics JSON path.")
    parser.add_argument("--img-dir", type=Path, default=DEFAULT_IMG_DIR, help="Output cropped PNG folder.")
    parser.add_argument("--no-images", action="store_true", help="Skip writing PNG crops.")
    args = parser.parse_args()

    pdf_files = [args.file] if args.file else [p for p in sorted(GAMRISA_DIR.glob("*.pdf")) if "(제18회)정보시스템" not in p.name]  # skip near-duplicate 2017 copy
    all_records: list[dict[str, Any]] = []
    all_diags: list[dict[str, Any]] = []

    for pdf in pdf_files:
        recs, diags = parse_gamrisa_pdf(pdf, args.img_dir, save_images=not args.no_images)
        all_records.extend(recs)
        all_diags.extend(diags)
        img_cnt = sum(1 for r in recs if r["has_image"])
        xcol_cnt = sum(1 for d in diags if d["is_cross_column"])
        xpage_cnt = sum(1 for d in diags if d["is_cross_page"])
        warn_cnt = sum(1 for d in diags if d["visual_keyword_warning"])
        print(
            f"Parsed {pdf.name}: {len(recs)} questions | images={img_cnt} | "
            f"xcol={xcol_cnt} | xpage={xpage_cnt} | keyword_warns={warn_cnt}"
        )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(all_records, ensure_ascii=False, indent=2), encoding="utf-8")
    args.diag_out.parent.mkdir(parents=True, exist_ok=True)
    args.diag_out.write_text(json.dumps(all_diags, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(all_records)} records -> {args.out}")
    print(f"Wrote {len(all_diags)} diagnostics -> {args.diag_out}")


if __name__ == "__main__":
    main()

