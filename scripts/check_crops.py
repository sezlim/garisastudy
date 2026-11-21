"""Automatic QA for Gamrisa crops and parsed JSON. Reports only suspicious items."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, default=Path("data/gamrisa_raw.json"))
    ap.add_argument("--img-dir", type=Path, default=Path("web/assets/images"))
    ap.add_argument("--max-ratio", type=float, default=2.2, help="max height/width")
    ap.add_argument("--max-mult", type=float, default=2.0, help="max height vs mean height")
    ap.add_argument("--min-kb", type=float, default=3.0)
    ap.add_argument("--max-kb", type=float, default=2500.0)
    ap.add_argument("--min-dpi-width", type=int, default=500, help="min width px (resolution sanity)")
    ap.add_argument("--expected", type=int, default=120, help="questions per round")
    args = ap.parse_args()

    records = json.loads(args.json.read_text(encoding="utf-8"))
    issues: list[str] = []

    # 1) non-png / size / ratio
    sizes: dict[str, tuple[int, int, float]] = {}
    files = sorted(p for p in args.img_dir.glob("*") if p.is_file())
    for p in files:
        if p.suffix.lower() != ".png":
            issues.append(f"[NOT_PNG] {p.name}")
            continue
        with p.open("rb") as f:
            if f.read(8) != PNG_MAGIC:
                issues.append(f"[BAD_PNG_HEADER] {p.name}")
                continue
        kb = p.stat().st_size / 1024
        try:
            with Image.open(p) as im:
                w, h = im.size
        except Exception as e:  # noqa: BLE001
            issues.append(f"[UNREADABLE] {p.name}: {e}")
            continue
        sizes[p.stem] = (w, h, kb)
        if kb < args.min_kb or kb > args.max_kb:
            issues.append(f"[FILE_SIZE] {p.name}: {kb:.1f} KB")
        if w < args.min_dpi_width:
            issues.append(f"[LOW_RES] {p.name}: width {w}px")
        if h / w >= args.max_ratio:
            issues.append(f"[TOO_TALL_RATIO] {p.name}: {w}x{h} ratio {h / w:.2f}")

    if sizes:
        mean_h = statistics.mean(h for _, h, _ in sizes.values())
        for stem, (w, h, _) in sizes.items():
            if h > args.max_mult * mean_h:
                issues.append(f"[TOO_TALL_MEAN] {stem}.png: h={h} > {args.max_mult}x mean({mean_h:.0f})")

    # 2) JSON <-> image consistency
    ids_with_img = {r["id"] for r in records if r["has_image"]}
    for r in records:
        if r["has_image"]:
            if not r["image_path"] or not Path(r["image_path"]).exists():
                issues.append(f"[MISSING_IMAGE_FILE] {r['id']}")
            elif not r["image_path"].endswith(".png"):
                issues.append(f"[IMAGE_NOT_PNG] {r['id']}")
        elif r["image_path"]:
            issues.append(f"[IMAGE_PATH_WITHOUT_FLAG] {r['id']}")
    for stem in sizes:
        if stem not in ids_with_img:
            issues.append(f"[ORPHAN_IMAGE] {stem}.png")

    # 3) missing / duplicate numbers per round
    by_round: dict[str, list[int]] = defaultdict(list)
    ids = set()
    for r in records:
        by_round[r["year_round"]].append(r["number"])
        if r["id"] in ids:
            issues.append(f"[DUP_ID] {r['id']}")
        ids.add(r["id"])
        if not r["question"].strip():
            issues.append(f"[EMPTY_QUESTION] {r['id']}")
    for rnd, nums in by_round.items():
        dup = sorted({n for n in nums if nums.count(n) > 1})
        missing = sorted(set(range(1, args.expected + 1)) - set(nums))
        if dup:
            issues.append(f"[DUP_NUMBER] {rnd}: {dup}")
        if missing:
            issues.append(f"[MISSING_NUMBER] {rnd}: {missing}")

    print(f"Checked {len(records)} records, {len(sizes)} images, {len(by_round)} round(s).")
    if issues:
        print(f"{len(issues)} issue(s):")
        for i in issues:
            print("  " + i)
        sys.exit(1)
    print("No anomalies found.")


if __name__ == "__main__":
    main()
