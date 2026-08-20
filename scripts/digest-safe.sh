#!/bin/bash
# digest-safe.sh — overlap-guarded wrapper around `librarian digest --apply`,
# meant to be run unattended by launchd (com.librarian.digest) every 3 days.
#
# Guarantees:
#   * Never two digests at once (atomic mkdir lock; stale locks >2h reclaimed).
#   * Exits 0 on a clean skip, nonzero on real failure.
#   * On failure the pending queue is untouched: digest does all Claude
#     synthesis BEFORE any file write, so an auth failure / timeout aborts
#     with zero writes (see src/commands/digest.ts).
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LIB_DIR="$HOME/.librarian"
LOCK="$LIB_DIR/digest.lock"
MAX_FACTS="${LIBRARIAN_DIGEST_MAX_FACTS:-2000}"

mkdir -p "$LIB_DIR"
log() { echo "[digest-safe] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# --- overlap guard (atomic mkdir) -------------------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
    log "reclaiming stale lock (>2h old): $LOCK"
    rmdir "$LOCK" 2>/dev/null || true
    if ! mkdir "$LOCK" 2>/dev/null; then
      log "SKIP: another digest run is in progress"
      exit 0
    fi
  else
    log "SKIP: another digest run is in progress"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# --- preflight ---------------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
  log "ERROR: claude CLI not on PATH ($PATH) — cannot synthesize; queue untouched"
  exit 1
fi
if [ ! -f "$REPO/dist/server.js" ]; then
  log "ERROR: $REPO/dist/server.js missing — run 'npm run build' in $REPO"
  exit 1
fi

# --- run ----------------------------------------------------------------------
log "starting: digest --apply --max-facts $MAX_FACTS (repo: $REPO)"
if node "$REPO/dist/server.js" digest --apply --max-facts "$MAX_FACTS"; then
  log "digest completed OK"
else
  rc=$?
  log "ERROR: digest failed (exit $rc). Pending queue left intact."
  log "ACTION NEEDED: check 'claude' auth (run: claude -p hi) and ~/.librarian/digest.log"
  exit "$rc"
fi
