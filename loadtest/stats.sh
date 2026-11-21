#!/usr/bin/env bash
# Samples a container's CPU and memory every few seconds: "epoch_seconds,cpu_percent,memory_mib" per line.
#   loadtest/stats.sh inklayer-loadtest-server-1 > loadtest/results/stats.csv &
# Stops when the container does. report.py --stats reads the output.
set -euo pipefail
container="${1:?container name}"
interval="${2:-3}"

while docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; do
  # e.g. "12.34%,180.5MiB / 448MiB"
  line="$(docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}}' "$container" 2>/dev/null || true)"
  if [[ -n "$line" ]]; then
    cpu="${line%%\%*}"
    mem="${line#*,}"; mem="${mem%% /*}"
    case "$mem" in
      *GiB) mib="$(awk -v v="${mem%GiB}" 'BEGIN { printf "%.1f", v * 1024 }')" ;;
      *MiB) mib="${mem%MiB}" ;;
      *KiB) mib="$(awk -v v="${mem%KiB}" 'BEGIN { printf "%.1f", v / 1024 }')" ;;
      *) mib="" ;;
    esac
    echo "$(date +%s),${cpu},${mib}"
  fi
  sleep "$interval"
done
