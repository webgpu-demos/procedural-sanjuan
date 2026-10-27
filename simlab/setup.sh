#!/bin/bash
# A runner made ready: SUMO, the inputs, the compiled city's road graph.
set -e
cd "$(dirname "$0")/.."
sudo mkdir -p /mnt/sim && sudo chown "$(id -u):$(id -g)" /mnt/sim
python3 -m venv .venv-sim
.venv-sim/bin/pip install -q eclipse-sumo==1.28.0 libsumo==1.28.0 numpy openpyxl pyshp pyarrow rtree
mkdir -p data/sim/census data/sim/gtfs data/sim/sanjuan public/tiles/sanjuan
cp simlab/inputs/{departures,municipios,pr_flows}.json data/sim/census/
cp simlab/inputs/PRITA_GTFS.zip data/sim/gtfs/
cp simlab/inputs/{hpms,buildings}.json data/sim/sanjuan/
for f in roads.json lanes.json manifest.json; do
  curl -sSfL -o public/tiles/sanjuan/$f "https://raw.githubusercontent.com/$REPO/gh-pages/tiles/sanjuan/$f"
done
ls -la public/tiles/sanjuan data/sim/*
nproc; free -g; df -h / /mnt
