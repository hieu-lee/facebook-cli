#!/usr/bin/env bash
# Explicit opt-in: creates ONE unique Only-me post, verifies its receipt, then trashes it.
set -euo pipefail
[[ ${1:-} == --live-post ]] || { echo 'usage: scripts/live-acceptance.sh --live-post [fb-binary]'; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FB=${2:-$ROOT/target/release/fb}
OUT=${E2E_OUTPUT:-$ROOT/target/live-e2e}
mkdir -p "$OUT"
text="fb cli e2e $(date -u +%Y%m%dT%H%M%SZ)-$$"
ref=''
cleanup() {
  if [[ -z $ref ]]; then
    ref=$("$FB" posts me -n 5 --full | awk -F'\t' -v t="$text" '$5 == t {print $1; exit}') || true
  fi
  if [[ -n $ref && $ref != '-' ]]; then "$FB" delete "$ref" | tee "$OUT/cleanup.txt"; fi
  "$FB" page acceptance close >/dev/null 2>&1 || true
}
trap cleanup EXIT
"$FB" --version | tee "$OUT/version.txt"
"$FB" post "$text" --to me | tee "$OUT/receipt.tsv"
IFS=$'\t' read -r status ref post < "$OUT/receipt.tsv"
[[ $status == posted && $ref == p* && $post == /* ]]
"$FB" view "$ref" | tee "$OUT/view.txt"
grep -F "$text" "$OUT/view.txt" >/dev/null
"$FB" page acceptance open "https://www.facebook.com$post" > "$OUT/snapshot.tsv"
# Verify body and audience on the live artifact, not merely the requested --to flag.
"$FB" page acceptance eval '(async()=>{await window.__fb.postReady();return document.body.innerText.includes("Đã chia sẻ với Chỉ mình tôi")||!!document.querySelector("img[alt=\"Chỉ mình tôi\"],img[alt=\"Only me\"]")})()' | grep -x true
"$FB" page acceptance shot "$OUT/only-me.jpg"
cleanup
ref=''
trap - EXIT
"$FB" posts me -n 1 --full > "$OUT/after-delete.tsv"
! grep -F "$text" "$OUT/after-delete.tsv"
echo 'PASS: verified Only-me post receipt, view, audience, and delete'
