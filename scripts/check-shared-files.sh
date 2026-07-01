#!/usr/bin/env bash
#
# check-shared-files.sh — detect drift between copies of shared app assets.
#
# Cargo examples vendor the same helper files and the same code blocks. This
# script has two kinds of check:
#
#   1. Whole-file checks — hash every copy of a basename under apps/, group by
#      content. Used for files meant to be byte-identical (getifaddrs_override.c)
#      and for files shown informationally (callback.sh, tunnel.py) where drift
#      may be intentional.
#
#   2. Region checks — extract a named block from every copy of a file (by
#      start/end regex) and compare only that block. tunnel.py differs per
#      service, but its NETWORKS = {...} relay/domain map must be identical
#      everywhere — so we compare just that block.
#
# Drift in anything STRICT (EXPECTED_IDENTICAL files or REGIONS) exits non-zero,
# so this works as a CI / pre-commit gate. Informational drift never fails.
#
# Usage:
#   scripts/check-shared-files.sh              # strict files + regions + info
#   scripts/check-shared-files.sh callback.sh  # whole-file check of named file(s)
#   scripts/check-shared-files.sh --all        # report every shared basename
#
# Compatible with the stock macOS bash 3.2 (no associative arrays / mapfile).

set -euo pipefail

# Whole files that MUST be identical everywhere. Drift => exit 1.
EXPECTED_IDENTICAL="getifaddrs_override.c callback.sh"

# Whole files reported for information (drift allowed, shown so it stays visible).
INFORMATIONAL="tunnel.py"

# Code regions that MUST be identical everywhere, even when the surrounding file
# differs. Format: "Label|basename|startRegex|endRegex" (extraction is inclusive
# of both the start and end lines). Drift => exit 1.
REGIONS="
NETWORKS map|tunnel.py|^NETWORKS = \{|^\}
"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Colours only when stdout is a terminal.
if [ -t 1 ]; then GREEN=$'\033[32m'; RED=$'\033[31m'; RST=$'\033[0m'; else GREEN=''; RED=''; RST=''; fi

find_copies() {
  find apps \
    -path '*/node_modules/*' -prune -o \
    -path '*/dist/*' -prune -o \
    -path '*/__pycache__/*' -prune -o \
    -path '*/.acurast/*' -prune -o \
    -type f -name "$1" -print | sort
}

# Print the region [start..end] (inclusive) from a file, or nothing if absent.
extract_region() {
  awk -v s="$2" -v e="$3" '
    !inblk && $0 ~ s { inblk=1; print; next }
    inblk            { print; if ($0 ~ e) exit }
  ' "$1"
}

# group_rows <label> "<hash<TAB>path lines>"  -> prints status; returns 1 on drift
group_rows() {
  local label="$1" rows="$2" count distinct empty_hash
  if [ -z "$rows" ]; then
    printf '  %-26s (no copies found)\n' "$label"; return 0
  fi
  count="$(printf '%s\n' "$rows" | wc -l | tr -d ' ')"
  distinct="$(printf '%s\n' "$rows" | cut -f1 | sort -u | wc -l | tr -d ' ')"

  if [ "$distinct" -eq 1 ]; then
    # hash of empty input => the region was missing in every copy
    empty_hash="$(printf '' | shasum -a 256 | awk '{print $1}')"
    if [ "$(printf '%s\n' "$rows" | head -1 | cut -f1)" = "$empty_hash" ]; then
      printf '  %s✗%s %-26s %s copies, but block NOT FOUND in any\n' "$RED" "$RST" "$label" "$count"
      return 1
    fi
    printf '  %s✓%s %-26s %s copies, all identical\n' "$GREEN" "$RST" "$label" "$count"
    return 0
  fi

  printf '  %s✗%s %-26s %s copies, %s distinct versions:\n' "$RED" "$RST" "$label" "$count" "$distinct"
  printf '%s\n' "$rows" | sort | awk -F'\t' '
    $1 != last { printf "      [%s]\n", substr($1,1,12); last=$1 }
    { printf "        %s\n", $2 }'
  return 1
}

# report_file <basename>
report_file() {
  local rows
  rows="$(find_copies "$1" | while read -r f; do
            printf '%s\t%s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"
          done)"
  group_rows "$1" "$rows"
}

# report_region <label> <basename> <startRegex> <endRegex>
report_region() {
  local label="$1" name="$2" start="$3" end="$4" rows
  rows="$(find_copies "$name" | while read -r f; do
            printf '%s\t%s\n' "$(extract_region "$f" "$start" "$end" | shasum -a 256 | awk '{print $1}')" "$f"
          done)"
  group_rows "$label ($name)" "$rows"
}

fail=0

# --- explicit file list: whole-file check of just those, strict ---
if [ "$#" -gt 0 ] && [ "${1:-}" != "--all" ]; then
  echo "Checking requested files (strict):"
  for f in "$@"; do report_file "$f" || fail=1; done
  echo
  [ "$fail" -ne 0 ] && echo "DRIFT DETECTED." >&2 || echo "All requested files are identical."
  exit "$fail"
fi

# --- strict whole-file set ---
echo "Files that MUST be identical:"
for f in $EXPECTED_IDENTICAL; do report_file "$f" || fail=1; done

# --- strict region set ---
echo
echo "Code regions that MUST be identical:"
# process substitution keeps the loop in the current shell so it can set fail
while IFS='|' read -r label name start end; do
  [ -z "$label" ] && continue
  report_region "$label" "$name" "$start" "$end" || fail=1
done < <(printf '%s\n' "$REGIONS")

# --- informational whole-file set ---
if [ "${1:-}" = "--all" ]; then
  info_files="$(find apps \
      -path '*/node_modules/*' -prune -o -path '*/dist/*' -prune -o \
      -path '*/__pycache__/*' -prune -o -path '*/.acurast/*' -prune -o \
      -type f -print | sed 's#.*/##' | sort | uniq -d)"
else
  info_files="$INFORMATIONAL"
fi

echo
echo "Informational (drift may be intentional):"
for f in $info_files; do report_file "$f" || true; done

echo
if [ "$fail" -ne 0 ]; then
  echo "DRIFT DETECTED in something expected to be identical." >&2
else
  echo "All must-match files and regions are identical."
fi
exit "$fail"
