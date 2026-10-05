#!/bin/sh
# Builds the site, with the compiled areas in public/, and publishes it to the gh-pages branch of origin, which
# GitHub Pages serves. The branch holds only the latest build (force-pushed), so the repository does not grow.
# Usage: npm run deploy   (compile the areas first: npm run fetch && npm run compile -- --area=<id>)
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
npm run build
touch dist/.nojekyll # (Pages would otherwise run Jekyll over thousands of tile files)
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C .. rev-parse --short HEAD)"
git push -f "$REMOTE" gh-pages
rm -rf .git
echo "deployed $(du -sh . | cut -f1) to gh-pages"
