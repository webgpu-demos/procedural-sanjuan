#!/bin/bash
# Runs simlab/jobs/$JOB.sh with RES (what to bring back) and W (scratch, /mnt), pushing RES to simres/$JOB as it goes.
cd "$(dirname "$0")/.."
export ROOT=$PWD RES=/mnt/res W=/mnt/sim PY=$PWD/.venv-sim/bin/python BIN=$PWD/.venv-sim/bin
mkdir -p "$RES" "$W"
push() {
  ( cd "$RES" && rm -rf .git && git init -q -b r && git add -A &&
    git -c user.name=simlab -c user.email=noreply@anthropic.com commit -qm "$JOB $(date -u +%FT%TZ) $1" &&
    for i in 1 2 3; do git push -qf "https://x-access-token:$GH_TOKEN@github.com/$REPO" r:"simres/$JOB" && break; sleep 10; done
    rm -rf .git ) || true
}
( while sleep 480; do push progress; done ) &
LOOP=$!
start=$(date +%s)
bash "simlab/jobs/$JOB.sh" > "$RES/job.log" 2>&1
code=$?
echo "exit $code after $(( ($(date +%s) - start) / 60 )) min" >> "$RES/job.log"
kill $LOOP 2>/dev/null
push "exit $code"
exit 0
