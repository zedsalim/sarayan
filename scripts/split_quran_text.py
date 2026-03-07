#!/usr/bin/env python3
"""
split_quran_text.py
====================
Splits a full Quran JSON file (hafs-quran.min.json / warsh-quran.min.json)
into 604 per-page chunk files for lazy loading.

Input JSON structure (array of ayah objects):
  [
    {
      "id": 1, "jozz": 1, "page": 1,
      "sura_no": 1, "sura_name_en": "...", "sura_name_ar": "...",
      "aya_no": 1, "aya_no_marker": "ﰀ", "aya_text": "..."
    },
    ...
  ]

Output:
  assets/text/pages/<riwaya>/001.json  →  604 files (stripped of redundant fields)
  assets/text/pages/<riwaya>/index.json  →  lightweight index with sura/juz→page map

Fields removed from every ayah in the chunk files:
  - "page"        → redundant: the file name IS the page number; JS injects it back
  - "id"          → redundant: derived as sura_no * 1000 + aya_no in JS (unique, stable)
  - "sura_name_en"→ never used

Fields kept:
  jozz, sura_no, sura_name_ar, aya_no, aya_no_marker, aya_text

Usage:
  python split_quran_text.py --input assets/text/warsh-quran.min.json --riwaya warsh
  python split_quran_text.py --input assets/text/hafs-quran.min.json  --riwaya hafs
"""

import argparse
import json
import os
from collections import defaultdict

# Fields to keep in each ayah chunk (order preserved in output)
KEEP_FIELDS = ("jozz", "sura_no", "sura_name_ar", "aya_no", "aya_no_marker", "aya_text")


def slim_ayah(item: dict) -> dict:
    """Return only the fields the app actually needs."""
    return {k: item[k] for k in KEEP_FIELDS if k in item}


def split_quran(input_path: str, riwaya: str, output_dir: str):
    print(f"Loading {input_path}...")
    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Normalise page field — original may be int or "1" or "1-2"
    for item in data:
        item["page"] = str(item["page"])

    # ── Group ayahs by their primary page ──────────────────────────────────────
    pages: dict[int, list] = defaultdict(list)
    for item in data:
        primary_page = int(item["page"].split("-")[0])
        pages[primary_page].append(item)

    # ── Write per-page files ───────────────────────────────────────────────────
    out_pages_dir = os.path.join(output_dir, "pages", riwaya)
    os.makedirs(out_pages_dir, exist_ok=True)

    total_saved = 0
    for page_num in range(1, 605):
        ayahs = pages.get(page_num, [])
        slimmed = [slim_ayah(a) for a in ayahs]
        out_path = os.path.join(out_pages_dir, f"{page_num:03d}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            # Compact JSON — no extra whitespace
            json.dump(slimmed, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  ✓ Wrote 604 page files → {out_pages_dir}/")

    # ── Build lightweight index ────────────────────────────────────────────────
    # Maps sura_no → first page, jozz → first page, and page → [sura_no list]
    index = {
        "sura_to_page": {},  # "1" → 1
        "juz_to_page": {},  # "1" → 1
        "page_to_suras": {},  # "1" → [1]
        "page_to_juz": {},  # "1" → 1
        "sura_info": {},  # "1" → {"name_ar":"...", "name_en":"...", "ayah_count": N}
    }

    sura_ayah_counts: dict[int, int] = defaultdict(int)
    sura_first_page: dict[int, int] = {}
    juz_first_page: dict[int, int] = {}
    page_suras: dict[int, list] = defaultdict(list)
    page_juz: dict[int, int] = {}

    sura_names: dict[int, dict] = {}

    for item in data:
        sno = item["sura_no"]
        jno = item["jozz"]
        pno = int(item["page"].split("-")[0])

        sura_ayah_counts[sno] += 1

        if sno not in sura_first_page:
            sura_first_page[sno] = pno
        if jno not in juz_first_page:
            juz_first_page[jno] = pno
        if sno not in page_suras[pno]:
            page_suras[pno].append(sno)
        page_juz[pno] = jno
        if sno not in sura_names:
            sura_names[sno] = {
                "name_ar": item["sura_name_ar"],
                "name_en": item["sura_name_en"],
            }

    index["sura_to_page"] = {str(k): v for k, v in sorted(sura_first_page.items())}
    index["juz_to_page"] = {str(k): v for k, v in sorted(juz_first_page.items())}
    index["page_to_suras"] = {str(k): v for k, v in sorted(page_suras.items())}
    index["page_to_juz"] = {str(k): v for k, v in sorted(page_juz.items())}
    index["sura_info"] = {
        str(k): {**sura_names[k], "ayah_count": sura_ayah_counts[k]}
        for k in sorted(sura_names)
    }

    index_path = os.path.join(out_pages_dir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    print(f"  ✓ Wrote index → {index_path}")
    print(f"  Total ayahs indexed: {len(data)}")
    print(f"  Surahs: {len(sura_first_page)}  |  Juz: {len(juz_first_page)}")


def main():
    parser = argparse.ArgumentParser(
        description="Split Quran JSON into per-page chunks"
    )
    parser.add_argument("--input", required=True, help="Path to full Quran JSON file")
    parser.add_argument(
        "--riwaya",
        required=True,
        choices=["warsh", "hafs"],
        help="Riwaya name (warsh or hafs)",
    )
    parser.add_argument(
        "--output-dir",
        default="assets/text",
        help="Base output directory (default: assets/text)",
    )
    args = parser.parse_args()

    split_quran(args.input, args.riwaya, args.output_dir)
    print("\nDone! Run for both riwaya:")
    print(
        f"  python split_quran_text.py --input assets/text/warsh-quran.min.json --riwaya warsh"
    )
    print(
        f"  python split_quran_text.py --input assets/text/hafs-quran.min.json  --riwaya hafs"
    )


if __name__ == "__main__":
    main()
