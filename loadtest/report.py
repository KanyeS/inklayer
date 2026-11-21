#!/usr/bin/env python3
"""Turns a k6 capacity or soak run into a per-step table and a capacity figure (Markdown on stdout).

    python3 loadtest/report.py loadtest/results/metrics.csv.gz --step-seconds 60 [--stats loadtest/results/stats.csv]

A step "holds" when read p95, write p95 (comments and replies), doc save p95, media p95 (uploads, recordings, issues
with files) and the error rate stay within the limits. The capacity is the busiest step
that held, as long as every step before it held too: a server that recovers after failing isn't trusted.

--stats: lines of "epoch_seconds,cpu_percent,memory_mib" from the server (see stats.sh), shown per step.
Standard library only, so it runs anywhere Python 3 does.
"""
import argparse
import csv
import gzip
import math
from collections import defaultdict
from urllib.parse import parse_qsl


def p95(values):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1)]


def fmt_ms(value):
    return "-" if value is None else f"{value:,.0f} ms"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("metrics", help="k6 CSV output (gzip or plain)")
    parser.add_argument("--step-seconds", type=int, default=60)
    parser.add_argument("--steps", type=int, help="steps in the run; later requests only finished late and are left out")
    parser.add_argument("--stats", help="server CPU/memory samples: epoch,cpu%%,MiB")
    parser.add_argument("--read-p95", type=float, default=500, help="ms (default 500)")
    parser.add_argument("--write-p95", type=float, default=1000, help="ms (default 1000)")
    parser.add_argument("--doc-save-p95", type=float, default=1000, help="ms (default 1000)")
    parser.add_argument("--media-p95", type=float, default=20000, help="ms (default 20000: bodies of tens of MB)")
    parser.add_argument("--max-error-rate", type=float, default=0.01, help="fraction (default 0.01)")
    args = parser.parse_args()

    opener = gzip.open if args.metrics.endswith(".gz") else open
    durations = defaultdict(lambda: {"read": [], "write": [], "doc": [], "media": []})
    failures = defaultdict(lambda: [0, 0])  # step -> [failed, total]
    live_open = defaultdict(int)
    live_errors = defaultdict(float)
    rows = []

    with opener(args.metrics, "rt", newline="") as f:
        for row in csv.DictReader(f):
            name = row["metric_name"]
            if name in ("http_req_duration", "http_req_failed", "ws_sessions", "live_errors", "doc_save_duration", "doc_errors"):
                rows.append(row)

    measured = [int(r["timestamp"]) for r in rows if "kind=setup" not in (r["extra_tags"] or "")]
    if not measured:
        raise SystemExit("No measured requests in the metrics file.")
    start = min(measured)

    def step_of(row):
        return (int(row["timestamp"]) - start) // args.step_seconds

    for row in rows:
        tags = dict(parse_qsl(row["extra_tags"] or ""))
        kind = tags.get("kind")
        if kind == "setup":
            continue
        step = step_of(row)
        if step < 0:
            continue
        name = row["metric_name"]
        value = float(row["metric_value"])
        if name == "http_req_duration" and kind in ("read", "write", "media"):
            durations[step][kind].append(value)
        elif name == "http_req_failed" and kind in ("read", "write", "media"):
            failures[step][0] += value
            failures[step][1] += 1
        elif name == "ws_sessions":
            live_open[step] += 1
        elif name in ("live_errors", "doc_errors"):
            live_errors[step] += value
        elif name == "doc_save_duration":
            durations[step]["doc"].append(value)

    stats = defaultdict(lambda: ([], []))
    if args.stats:
        with open(args.stats) as f:
            for line in f:
                parts = line.strip().split(",")
                if len(parts) != 3:
                    continue
                try:
                    epoch, cpu, mem = int(parts[0]), float(parts[1]), float(parts[2])
                except ValueError:
                    continue
                step = (epoch - start) // args.step_seconds
                if step >= 0:
                    stats[step][0].append(cpu)
                    stats[step][1].append(mem)

    steps = sorted(set(durations) | set(failures))
    late = [s for s in steps if args.steps is not None and s >= args.steps]
    steps = [s for s in steps if s not in late]
    header = ("| Step | Reads/s | Writes/s | Doc saves/s | Media/min | Read p95 | Write p95 | Doc save p95 | Media p95 | Errors "
              "| WebSocket sessions started | Live/doc errors |")
    divider = "|---|---|---|---|---|---|---|---|---|---|---|---|"
    if args.stats:
        header += " Server CPU (max) | Server memory (max) |"
        divider += "---|---|"
    print(header)
    print(divider)

    capacity = None
    broke_at = None
    for step in steps:
        reads, writes, saves, media = durations[step]["read"], durations[step]["write"], durations[step]["doc"], durations[step]["media"]
        failed, total = failures[step]
        error_rate = failed / total if total else 0
        read_p95, write_p95, save_p95, media_p95 = p95(reads), p95(writes), p95(saves), p95(media)
        held = (
            (read_p95 is None or read_p95 <= args.read_p95)
            and (write_p95 is None or write_p95 <= args.write_p95)
            and (save_p95 is None or save_p95 <= args.doc_save_p95)
            and (media_p95 is None or media_p95 <= args.media_p95)
            and error_rate <= args.max_error_rate
            and live_errors[step] == 0
        )
        seconds = args.step_seconds
        line = (f"| {step + 1} {'✅' if held else '❌'} | {len(reads) / seconds:,.1f} | {len(writes) / seconds:,.1f} | "
                f"{len(saves) / seconds:,.1f} | {len(media) * 60 / seconds:,.0f} | {fmt_ms(read_p95)} | {fmt_ms(write_p95)} | "
                f"{fmt_ms(save_p95)} | {fmt_ms(media_p95)} | "
                f"{error_rate:.2%} | {live_open[step]} | {live_errors[step]:.0f} |")
        if args.stats:
            cpus, mems = stats[step]
            line += f" {max(cpus):.0f}% |" if cpus else " - |"
            line += f" {max(mems):.0f} MiB |" if mems else " - |"
        print(line)
        if held and broke_at is None:
            capacity = (step, len(reads) / seconds, len(writes) / seconds, len(saves) / seconds)
        elif not held and broke_at is None:
            broke_at = step

    if late:
        late_total = sum(len(durations[s]["read"]) + len(durations[s]["write"]) + len(durations[s]["media"]) for s in late)
        late_failed = sum(failures[s][0] for s in late)
        print(f"\nAfter the last step, {late_total:,} requests still finished ({late_failed:,.0f} failed): left out of the table.")
    print()
    print(f"Limits: read p95 ≤ {args.read_p95:.0f} ms, write p95 ≤ {args.write_p95:.0f} ms, "
          f"doc save p95 ≤ {args.doc_save_p95:.0f} ms, media p95 ≤ {args.media_p95:.0f} ms, errors ≤ {args.max_error_rate:.0%}, no live or doc connection errors.")
    if capacity is None:
        print("**Capacity: the first step already broke the limits.** Lower the starting load.")
    else:
        step, read_rate, write_rate, save_rate = capacity
        print(f"**Capacity: step {step + 1}, about {read_rate:,.0f} reads/s, {write_rate:,.0f} comment writes/s "
              f"and {save_rate:,.0f} doc saves/s together.**")
        if broke_at is None:
            print("Every step held, so the real limit is higher: raise the maximums and run again.")
        else:
            print(f"Step {broke_at + 1} was the first to break.")


if __name__ == "__main__":
    main()
