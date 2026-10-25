#!/usr/bin/env bash
# Live read-only smoke test against your logged-in profile. Usage: scripts/smoke.sh [path/to/fb]
set -u
FB=${1:-./target/release/fb}
fail=0
check() { # name, min_lines, cmd...
  local name=$1 min=$2; shift 2
  local out rc n; out=$("$@" 2>&1); rc=$?; n=$(printf '%s\n' "$out" | grep -c .)
  if [ "$rc" -eq 0 ] && [ "$n" -ge "$min" ]; then echo "ok   $name ($n lines)"; else echo "FAIL $name:"; printf '%s\n' "$out" | head -5; fail=1; fi
}
check status 2 "$FB" status
check feed 3 "$FB" feed -n 3
check posts 2 "$FB" posts me -n 2
check profile 3 "$FB" profile me
check friends 3 "$FB" friends -n 3
check search 1 "$FB" search "john" -n 2
check notifs 1 "$FB" notifs -n 2
check chats 3 "$FB" chats -n 3
chat=$("$FB" chats -n 8 | awk -F'\t' '$2 !~ /e/ {print $1; exit}')
[ -n "$chat" ] && check read 2 "$FB" read "$chat" -n 3
check batch 6 "$FB" batch "feed -n 2" "chats -n 2" "notifs -n 2"
exit $fail
