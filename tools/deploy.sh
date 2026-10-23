#!/bin/sh
# Builds the site, with the compiled areas in public/, and publishes it to the gh-pages branch of origin, which
# GitHub Pages serves. The branch holds only the latest build (force-pushed), so the repository does not grow.
# Usage: npm run deploy   (compile the areas first: npm run fetch && npm run compile -- --area=<id>)
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
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
