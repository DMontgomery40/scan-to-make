#!/usr/bin/env python3
"""Bounded host-side adapter over the existing capture tools, without measured truth."""
import argparse
import json
import math
from pathlib import Path
import resource
import sys

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "tools/capture-pipeline"))
sys.path.insert(0, str(REPO / "tools/capture-mesh-convert"))
from pipeline import check_input  # noqa: E402
from convert import convert  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-source-bytes", type=int, required=True)
    parser.add_argument("--max-derived-bytes", type=int, required=True)
    parser.add_argument("--timeout-ms", type=int, required=True)
    args = parser.parse_args()
    try:
        cpu = max(1, math.ceil(args.timeout_ms / 1000))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (args.max_derived_bytes, args.max_derived_bytes))
        source = Path(args.source)
        if source.stat().st_size > args.max_source_bytes:
            raise ValueError("capture source byte limit exceeded")
        data = source.read_bytes()
        check_input(data, source.name, args.max_source_bytes, 256, 128 * 1024 * 1024)
        report = convert(source, args.out)
        Path(args.report).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        return 0 if report["metricQualified"] else 4
    except Exception as exc:
        print(f"capture conversion rejected: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
