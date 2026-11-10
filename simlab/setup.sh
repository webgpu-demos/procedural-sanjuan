#!/bin/bash
# A runner made ready: SUMO, the inputs, the compiled city's road graph.
set -e
trap 'echo "::error title=setup failed::line $LINENO"' ERR
cd "$(dirname "$0")/.."
sudo mkdir -p /mnt/sim /mnt/res && sudo chown "$(id -u):$(id -g)" /mnt/sim /mnt/res
python3 -m venv .venv-sim
.venv-sim/bin/pip install -q eclipse-sumo==1.28.0 libsumo==1.28.0 numpy scipy openpyxl pyshp pyarrow rtree
mkdir -p data/sim/census data/sim/gtfs data/sim/sanjuan public/tiles/sanjuan
cp simlab/inputs/{departures,municipios,pr_flows}.json data/sim/census/
cp simlab/inputs/PRITA_GTFS.zip data/sim/gtfs/
cp simlab/inputs/{hpms,buildings}.json data/sim/sanjuan/
# the compiled city's road files from TILES_REF (simlab/tiles-ref, else gh-pages: the published site): a branch that holds
# them at tiles/sanjuan/ as the site does, so that a run can be made on roads compiled and not yet published
TILES_REF=${TILES_REF:-$(cat simlab/tiles-ref 2>/dev/null || echo gh-pages)}
for f in roads.json lanes.json manifest.json; do
  curl -sSfL -o public/tiles/sanjuan/$f "https://raw.githubusercontent.com/$REPO/refs/heads/$TILES_REF/tiles/sanjuan/$f"
done
echo "::notice title=tiles::from $TILES_REF, roads.json sha1 $(sha1sum public/tiles/sanjuan/roads.json | cut -c1-12)"
ls -la public/tiles/sanjuan data/sim/*
echo "::notice title=runner::$(nproc) cpus, $(free -g | awk '/Mem/{print $2}') GB, python $(python3 -V), $(df -h /mnt | tail -1)"
