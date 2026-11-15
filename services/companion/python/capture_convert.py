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


# Python with usd-core maps about 0.5 GB before reading anything; a 200 MB rebuild peaks well under 1 GB.
MAX_ADDRESS_BYTES = 4 * 1024 * 1024 * 1024


def limit_address_space(limit):
    """RLIMIT_AS where the system enforces it (Linux). macOS accepts no address-space limit below its own reservation
    and enforces none, so there the bound is the streaming reads and one conversion at a time (capture-converter.ts)."""
    if sys.platform != "linux" or not limit:
        return
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    ceiling = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
    resource.setrlimit(resource.RLIMIT_AS, (ceiling, hard))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-source-bytes", type=int, required=True)
    parser.add_argument("--max-derived-bytes", type=int, required=True)
    parser.add_argument("--timeout-ms", type=int, required=True)
    # #852: this computer's own rebuild, read for its mesh alone. Its size is textures the design engine never reads.
    parser.add_argument("--geometry-only", action="store_true")
    # #852 review P1-1: the converter's address space, so a scan that would page the computer stops instead.
    parser.add_argument("--max-address-bytes", type=int, default=MAX_ADDRESS_BYTES)
    args = parser.parse_args()
    try:
        cpu = max(1, math.ceil(args.timeout_ms / 1000))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (args.max_derived_bytes, args.max_derived_bytes))
        limit_address_space(args.max_address_bytes)
        source = Path(args.source)
        if source.stat().st_size > args.max_source_bytes:
            raise ValueError("capture source byte limit exceeded")
        # Checked and hashed from disk: a 200 MB rebuild is never held whole in memory (#852, review P1-1).
        check_input(source, source.name, args.max_source_bytes, 256,
                    max(128 * 1024 * 1024, args.max_source_bytes) if args.geometry_only else 128 * 1024 * 1024)
        report = convert(source, args.out, geometry_only=args.geometry_only)
        Path(args.report).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        return 0 if report["metricQualified"] else 4
    except Exception as exc:
        print(f"capture conversion rejected: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
