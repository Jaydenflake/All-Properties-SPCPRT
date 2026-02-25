#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$ROOT_DIR/indexes"
SRC_DIR="$ROOT_DIR/.sources"
MANIFEST="$ROOT_DIR/manifest.csv"

mkdir -p "$OUT_DIR" "$SRC_DIR"

# property_name|owner/repo
PROPERTIES=$(cat <<'LIST'
Red Arrow Ranch|HansenHomeAI/Red-Arrow-Ranch
Copper Rock|HansenHomeAI/Copper-Rock
Hart Bench Ranch|HansenHomeAI/HBR-SHELL
Edgewood Farm|HansenHomeAI/Edgewood
Cromwell Island|HansenHomeAI/C-CORE
Three Rivers|HansenHomeAI/PaulTHR
Dolan Road|HansenHomeAI/DolanRoad-CORE
Hill Street|HansenHomeAI/Hillst
Deer Knoll|HansenHomeAI/Deer-Knoll
Wolf Creek|HansenHomeAI/Fourth10716
Six-S Ranch|HansenHomeAI/Six-S-Core
Resort Drive|HansenHomeAI/PaCi
TL400|HansenHomeAI/Netarts
Jones Creek|HansenHomeAI/JoC
Mt Pleasant|HansenHomeAI/MtPleasant
Park Road|HansenHomeAI/park-rd
Columbia Eden|HansenHomeAI/UpColumbiaEden
46th Street|HansenHomeAI/38510SE
LIST
)

printf 'property,repo,created_at,file_date,output_file,source_path\n' > "$MANIFEST"

while IFS='|' read -r property repo; do
  [ -z "$property" ] && continue

  created_at=$(gh api "repos/$repo" --jq '.created_at')
  file_date=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$created_at" "+%m-%d-%y")

  property_slug=$(echo "$property" | sed -E 's/[[:space:]]+/-/g; s/[^A-Za-z0-9-]//g; s/-+/-/g; s/^-|-$//g')
  out_file="index(${property_slug}-${file_date}).html"

  clone_dir="$SRC_DIR/${property_slug}"
  rm -rf "$clone_dir"
  git clone --depth 1 "https://github.com/$repo.git" "$clone_dir" >/dev/null 2>&1

  src_file="$clone_dir/index.html"
  if [ ! -f "$src_file" ]; then
    candidate=$(find "$clone_dir" -type f -name 'index.html' \
      -not -path '*/.git/*' \
      -not -path '*/node_modules/*' \
      -not -path '*/dist/*' \
      -not -path '*/build/*' \
      | awk -F/ '{print NF "|" $0}' \
      | sort -n -t'|' -k1,1 -k2,2 \
      | head -n1 \
      | cut -d'|' -f2-)

    if [ -z "${candidate:-}" ]; then
      echo "ERROR: No index.html found for $property ($repo)" >&2
      exit 1
    fi
    src_file="$candidate"
  fi

  cp "$src_file" "$OUT_DIR/$out_file"
  printf '%s,%s,%s,%s,%s,%s\n' \
    "$property" "$repo" "$created_at" "$file_date" "$out_file" "${src_file#$ROOT_DIR/}" >> "$MANIFEST"

  echo "Imported $property -> $out_file"
done <<< "$PROPERTIES"

echo "Done. Wrote files to $OUT_DIR"
