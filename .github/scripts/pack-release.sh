#!/usr/bin/env bash
# Build the VSIX for the selected checkout with the tag commit's timestamp.
set -euo pipefail
sha=${1:?Supply the full commit SHA}
output=${2:?Supply an absolute output filename}
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$output" == /* && ! -e "$output" && ! -L "$output" ]]
[[ "$(git rev-parse HEAD)" == "$sha" ]]
epoch=$(git show -s --format=%ct "$sha")
TZ=UTC SOURCE_DATE_EPOCH="$epoch" npm run package -- --out "$output"
[[ -f "$output" && ! -L "$output" ]]
