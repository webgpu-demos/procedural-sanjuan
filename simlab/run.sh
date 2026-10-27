#!/bin/bash
# Runs simlab/jobs/$JOB.sh with RES (what to bring back) and W (scratch, /mnt), pushing RES to simres/$JOB as it goes.
cd "$(dirname "$0")/.."
export ROOT=$PWD RES=/mnt/res W=/mnt/sim PY=$PWD/.venv-sim/bin/python BIN=$PWD/.venv-sim/bin
mkdir -p "$RES" "$W"
push() {
  ( cd "$RES" && rm -rf .git && git init -q -b r && git add -A &&
    git -c user.name=simlab -c user.email=noreply@anthropic.com commit -qm "$JOB $(date -u +%FT%TZ) $1" &&
    ok=0; for i in 1 2 3; do git push -qf "https://x-access-token:$GH_TOKEN@github.com/$REPO" r:"simres/$JOB" 2> /tmp/push.err && { ok=1; break; }; sleep 10; done
    [ $ok = 1 ] || echo "::error title=push failed::$(tail -c 900 /tmp/push.err | tr '\n' ' ')"
    rm -rf .git ) || echo "::error title=push::could not commit"
}
( while sleep 480; do push progress; done ) &
LOOP=$!
start=$(date +%s)
bash "simlab/jobs/$JOB.sh" > "$RES/job.log" 2>&1
code=$?
echo "exit $code after $(( ($(date +%s) - start) / 60 )) min" >> "$RES/job.log"
kill $LOOP 2>/dev/null
push "exit $code"
# (the job's log cannot be fetched from here: its last lines as an annotation)
echo "::notice title=$JOB exit $code::$(tail -c 3000 "$RES/job.log" | tr '\r' '\n' | tail -n 25 | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')"
exit 0
