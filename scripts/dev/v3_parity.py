#!/usr/bin/env python3
"""
Developer check: compare a CSV exported from the V3.0 demo tab with a
reference run of the same ONNX model in Python (onnxruntime, CPU).

The reference follows the BirdNET V3.0 command-line analyzer: audio loaded
with librosa at 32 kHz mono, fixed windows (zero-padded at the end), sigmoid
scores straight from the model. Use the same window, overlap and minimum
confidence as in the demo, with all species groups enabled and no location
filter or manual edits.

    pip install onnxruntime librosa numpy
    npm run fetch-models
    python scripts/dev/v3_parity.py public/audio/BirdNET_soundscape_32kHz.flac demo.csv

Exits with status 1 if rows differ or a score differs by more than --tolerance.
"""

import argparse
import csv
import sys
from pathlib import Path

import librosa
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
SR = 32000


def default(pattern):
    hits = sorted((ROOT / "_models").glob(pattern))
    return str(hits[0]) if hits else None


def load_labels(path):
    with open(path, newline="", encoding="utf-8") as f:
        return [f"{r['sci_name'].strip()}_{r['com_name'].strip()}" for r in csv.DictReader(f, delimiter=";")]


def reference_rows(audio, model, labels, chunk, overlap, min_conf):
    y, _ = librosa.load(audio, sr=SR, mono=True)
    length, step = round(chunk * SR), round(chunk * SR) - round(overlap * SR)
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    rows = {}
    for start in range(0, len(y), step):
        end = min(start + length, len(y))
        window = np.zeros((1, length), dtype=np.float32)
        window[0, : end - start] = y[start:end]
        scores = session.run(["predictions"], {"input": window})[0][0]
        for i in np.where(scores >= min_conf)[0]:
            rows[(round(start / SR, 3), round(end / SR, 3), labels[i])] = float(scores[i])
        if end >= len(y):
            break
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio")
    parser.add_argument("web_csv", help="CSV downloaded from the V3.0 tab")
    parser.add_argument("--model", default=default("dist/v3/*.onnx"))
    parser.add_argument("--labels", default=default("upstream/*V3.0*Labels.csv"))
    parser.add_argument("--chunk", type=float, default=3.0)
    parser.add_argument("--overlap", type=float, default=0.0)
    parser.add_argument("--min-conf", type=float, default=0.15)
    parser.add_argument("--tolerance", type=float, default=0.005)
    args = parser.parse_args()
    if not args.model or not args.labels:
        sys.exit("Model or labels not found; run `npm run fetch-models` or pass --model/--labels.")

    ref = reference_rows(args.audio, args.model, load_labels(args.labels), args.chunk, args.overlap, args.min_conf)
    with open(args.web_csv, newline="", encoding="utf-8") as f:
        web = {(round(float(r["start_sec"]), 3), round(float(r["end_sec"]), 3), r["label"]): float(r["confidence"]) for r in csv.DictReader(f)}

    only_ref, only_web = sorted(set(ref) - set(web)), sorted(set(web) - set(ref))
    diffs = [abs(ref[k] - web[k]) for k in set(ref) & set(web)]
    print(f"reference rows: {len(ref)}, demo rows: {len(web)}, shared: {len(diffs)}")
    if diffs:
        print(f"max |diff|: {max(diffs):.6f}, mean |diff|: {sum(diffs) / len(diffs):.6f}")
    for label, keys in (("only in reference", only_ref), ("only in demo", only_web)):
        for k in keys[:10]:
            print(f"  {label}: {k}")
    # Rows near the threshold may flip within the tolerance; ignore those
    flips = [k for k in only_ref if ref[k] - args.min_conf > args.tolerance] + [k for k in only_web if web[k] - args.min_conf > args.tolerance]
    ok = not flips and (not diffs or max(diffs) <= args.tolerance)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
