#!/usr/bin/env python3
"""
split_reciters.py — unified chunk generator
============================================
All CDN types produce the same [account, token] structure.

  Cloudinary:
    {
      "base":  "https://res.cloudinary.com/",
      "pre_v": "video/upload",
      "path":  "quran/hafs/reciter/001/",
      "ayahs": { "001": [["doodco3hy","v1772300267"], ...] }
    }
    URL = base + acc + "/" + pre_v + "/" + tok + "/" + path + k + ".mp3"

  ImageKit:
    {
      "base": "https://ik.imagekit.io/",
      "path": "quran/warsh/reciter/001/",
      "ayahs": { "001": [["asyvqlb57","001.mp3"], ["htqhn8sa2","001.mp3"], ...] }
    }
    URL = base + acc + "/" + path + tok

  Same shape, same JS destructuring:  const [acc, tok] = entry;
  Only difference: pre_v present → Cloudinary reconstruction, absent → ImageKit.

Usage:
  python split_reciters.py --scan assets/audio_cloud
  python split_reciters.py --input path/to/file.json --riwaya hafs
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

_CLD_RE = re.compile(r"^https://res\.cloudinary\.com/([^/]+)/(.+?)/(v\d+)/(.+)$")


def parse_url(url: str):
    from urllib.parse import urlparse

    m = _CLD_RE.match(url)
    if m:
        account = m.group(1)
        pre_v = m.group(2)  # "video/upload"
        version = m.group(3)  # "v1772300267"
        rest = m.group(4)  # "quran/hafs/.../001/001.mp3"
        path = rest[: rest.rfind("/") + 1] if "/" in rest else ""
        return ("cld", account, pre_v, version, path)

    p = urlparse(url)
    base = f"{p.scheme}://{p.netloc}/"
    parts = p.path.lstrip("/").split("/", 1)
    if len(parts) == 2:
        account, rest = parts
        path = rest[: rest.rfind("/") + 1] if "/" in rest else ""
        filename = rest[rest.rfind("/") + 1 :] if "/" in rest else rest
        return ("ik", base, account, path, filename)
    return ("unknown",)


# ── Accumulator ───────────────────────────────────────────────────────────────
_accumulator: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))


def accumulate_file(input_path: Path, riwaya: str) -> bool:
    try:
        data = json.loads(input_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  ✗ {input_path.name}: {e}")
        return False

    reciters_data = data.get("reciters", {})
    if not reciters_data:
        print(f"  ✗ No 'reciters' key in {input_path.name}")
        return False

    for reciter, surahs in reciters_data.items():
        bucket = _accumulator[f"{riwaya}/{reciter}"]
        for surah_key, ayahs_list in surahs.items():
            for entry in ayahs_list or []:
                url = entry.get("url", "")
                if url:
                    bucket[surah_key][entry["ayah"]].append(url)
    return True


def build_chunk(ayah_url_map: dict) -> dict:
    sample = [urls[0] for urls in ayah_url_map.values() if urls]
    if not sample:
        return {}

    first = parse_url(sample[0])

    # ── Cloudinary ────────────────────────────────────────────────────────────
    if first[0] == "cld":
        pre_vs, paths = set(), set()
        ayah_map = {}
        ok = True

        for k in sorted(ayah_url_map):
            entries, seen = [], set()
            for url in ayah_url_map[k]:
                r = parse_url(url)
                if r[0] != "cld":
                    ok = False
                    break
                _, acc, pre_v, version, path = r
                pre_vs.add(pre_v)
                paths.add(path)
                key = (acc, version)
                if key not in seen:
                    seen.add(key)
                    entries.append([acc, version])
            if not ok:
                break
            ayah_map[k] = entries

        if ok and len(paths) == 1:
            return {
                "base": "https://res.cloudinary.com/",
                "pre_v": pre_vs.pop(),
                "path": paths.pop(),
                "ayahs": ayah_map,
            }

    # ── ImageKit / generic ────────────────────────────────────────────────────
    if first[0] == "ik":
        base_val = first[1]
        paths = set()
        ayah_map = {}
        ok = True

        for k in sorted(ayah_url_map):
            entries, seen = [], set()
            for url in ayah_url_map[k]:
                r = parse_url(url)
                if r[0] != "ik":
                    ok = False
                    break
                _, _base, acc, path, filename = r
                paths.add(path)
                key = (acc, filename)
                if key not in seen:
                    seen.add(key)
                    entries.append([acc, filename])  # token = "001.mp3"
            if not ok:
                break
            ayah_map[k] = entries

        if ok and len(paths) == 1:
            return {
                "base": base_val,
                "path": paths.pop(),
                "ayahs": ayah_map,
            }

    # ── Fallback: store full URLs ─────────────────────────────────────────────
    ayah_map = {}
    for k in sorted(ayah_url_map):
        urls = list(dict.fromkeys(ayah_url_map[k]))
        ayah_map[k] = urls[0] if len(urls) == 1 else urls
    return {"ayahs": ayah_map}


def flush_accumulator(output_base: Path) -> int:
    total = 0
    for reciter_key, surah_map in sorted(_accumulator.items()):
        riwaya, reciter = reciter_key.split("/", 1)
        out_dir = output_base / riwaya / "lazy" / reciter
        out_dir.mkdir(parents=True, exist_ok=True)

        for surah_key, ayah_url_map in sorted(
            surah_map.items(), key=lambda x: int(x[0])
        ):
            chunk = build_chunk(ayah_url_map)
            (out_dir / f"{int(surah_key):03d}.json").write_text(
                json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
            )
            total += 1

        surahs = sorted(int(p.stem) for p in out_dir.glob("???.json"))
        (out_dir / "index.json").write_text(
            json.dumps({"surahs": surahs}, separators=(",", ":"))
        )
        print(f"  ✓ {riwaya}/{reciter}: {len(surah_map)} surahs")
    return total


def detect_riwaya(path: Path) -> str | None:
    parts = [p.lower() for p in path.parts]
    if "warsh" in parts:
        return "warsh"
    if "hafs" in parts:
        return "hafs"
    return None


def scan_and_process(scan_root: Path, output_base: Path, include_unminified=False):
    all_json = sorted(scan_root.rglob("*.json"))

    def keep(p):
        pl = [x.lower() for x in p.parts]
        if "lazy" in pl:
            return False
        if not include_unminified and "unminified" in pl:
            return False
        return True

    files = [p for p in all_json if keep(p)]
    n_skip = sum(
        1
        for p in all_json
        if "unminified" in [x.lower() for x in p.parts]
        and "lazy" not in [x.lower() for x in p.parts]
    )

    if not files:
        print(f"No JSON files found under {scan_root}")
        return

    print(
        f"Found {len(files)} file(s) to process"
        + (f" ({n_skip} unminified skipped)" if n_skip else "")
        + "\n"
    )

    loaded = 0
    for jf in files:
        riwaya = detect_riwaya(jf)
        if not riwaya:
            print(f"  ? Cannot detect riwaya for {jf}")
            continue
        print(f"[{riwaya.upper()}] {jf.relative_to(scan_root)}", flush=True)
        if accumulate_file(jf, riwaya):
            loaded += 1

    print(f"\nMerging & writing …\n")
    total = flush_accumulator(output_base)
    print(f"\n{'─'*50}")
    print(f"Files loaded  : {loaded}")
    print(f"Surahs written: {total}")
    print(f"Output → {output_base}/{{warsh,hafs}}/lazy/")


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--scan", metavar="DIR")
    g.add_argument("--input", metavar="FILE")
    ap.add_argument("--riwaya", choices=["warsh", "hafs"])
    ap.add_argument("--output-dir", default="assets/audio_cloud", metavar="DIR")
    ap.add_argument("--include-unminified", action="store_true")
    args = ap.parse_args()

    output_base = Path(args.output_dir)
    if args.scan:
        d = Path(args.scan)
        if not d.is_dir():
            print(f"Error: {d} not a directory", file=sys.stderr)
            sys.exit(1)
        scan_and_process(d, output_base, args.include_unminified)
    else:
        if not args.riwaya:
            ap.error("--riwaya required with --input")
        f = Path(args.input)
        if not f.is_file():
            print(f"Error: {f} not found", file=sys.stderr)
            sys.exit(1)
        accumulate_file(f, args.riwaya)
        print(f"→ {flush_accumulator(output_base)} surah(s) written")


if __name__ == "__main__":
    main()
