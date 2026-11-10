#!/bin/sh
# Builds the site, with the compiled areas in public/, and publishes it to the gh-pages branch of origin, which
# GitHub Pages serves. The branch holds only the latest build (force-pushed), so the repository does not grow.
# Usage: npm run deploy   (compile the areas first: npm run fetch && npm run compile -- --area=<id>)
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
# what is published is what is committed: a build from changes nobody can see again cannot be rebuilt or reviewed
if ! git diff --quiet HEAD --; then echo "uncommitted changes to tracked files: commit them first; not deploying" >&2; exit 1; fi
# each published run was made on the roads its area's tiles have (tools/sim/network.mjs hashes the roads.json it builds
# on, run.py writes it into the run's index.json): a run on other roads drives its cars off the painted lanes and
# through what the tiles have since put in their way. (ALLOW_UNHASHED=1 publishes a run older than the hash.)
for idx in public/tiles/*/sim/morning/index.json public/tiles/*/sim/apagon/index.json; do
  [ -f "$idx" ] || continue
  node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const idx = process.argv[1], dir = path.join(path.dirname(idx), "../..");
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const have = crypto.createHash("sha1").update(fs.readFileSync(path.join(dir, m.roads))).digest("hex");
    const ran = JSON.parse(fs.readFileSync(idx, "utf8")).roads;
    if (!ran && process.env.ALLOW_UNHASHED === "1") { console.log(`${idx}: no roads hash (made before it was recorded); published as asked`); process.exit(0); }
    if (ran !== have) { console.error(`${idx}: made on roads ${ran ? ran.slice(0, 8) : "(not recorded)"}, the tiles have ${have.slice(0, 8)}: run tools/sim again on these roads; not deploying`); process.exit(1); }
  ' "$idx"
done
npm run build
touch dist/.nojekyll # (Pages would otherwise run Jekyll over thousands of tile files)
# of the simulated runs, only the published ones (test and trial runs stay local)
for d in dist/tiles/*/sim/*/; do
  case "$(basename "$d")" in morning|apagon) ;; *) rm -rf "$d"; echo "not publishing $d" ;; esac
done
# GitHub Pages serves a site of at most 1 GB
SIZE=$(du -sk dist | cut -f1)
if [ "$SIZE" -gt 980000 ]; then echo "dist is $((SIZE / 1024)) MB: over the 1 GB that Pages serves; not deploying" >&2; exit 1; fi
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C .. rev-parse --short HEAD)"
git push -f "$REMOTE" gh-pages
rm -rf .git
echo "deployed $(du -sh . | cut -f1) to gh-pages"
