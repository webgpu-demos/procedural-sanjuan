#!/usr/bin/env bash
# A smoke test of the harness, not an experiment: part of a synthetic export stands in for "real" frames, every
# condition trains for one epoch at 320 px on the CPU. Checks that prepare.py and run.py run end to end and that
# results.csv and summary.md come out.  bash smoke.sh <synthetic export dir> [work dir]
set -euo pipefail
SYN="$1"; W="${2:-/tmp/synth-smoke}"; HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$W"; mkdir -p "$W/fake_real/images" "$W/fake_real/labels" "$W/syn/images/train" "$W/syn/labels/train"
# the first half of the export as "real" (flights = the frame number's hundreds), the rest as synthetic
i=0
for img in $(ls "$SYN"/images/*/*.jpg | sort); do
  n=$(basename "$img" .jpg); lab=$(ls "$SYN"/labels/*/"$n".txt)
  if [ $((i % 2)) -eq 0 ]; then d="$W/fake_real"; f="flight$((i / 6))_$n"; ln -s "$img" "$d/images/$f.jpg"; cp "$lab" "$d/labels/$f.txt"
  else ln -s "$img" "$W/syn/images/train/$n.jpg"; cp "$lab" "$W/syn/labels/train/$n.txt"; fi
  i=$((i + 1))
done
python3 "$HERE/prepare.py" --real "$W/fake_real" --real-names building,blue_tarp,debris,vehicle --synth "$W/syn" --group '^(flight[0-9]+)_' \
  --real-fracs 0.5,1 --synth-ratios 0,1,only --seeds 0 --out "$W/exp"
python3 "$HERE/run.py" --exp "$W/exp" --model yolo11n.pt --epochs 1 --imgsz 320 --batch 4 --device cpu --workers 0 --finetune
test -s "$W/exp/results.csv" && test -s "$W/exp/summary.md" && echo "smoke: ok ($(($(wc -l < "$W/exp/results.csv") - 1)) runs)"
