#!/usr/bin/env bash
# Deletes everything created by deploy.sh by deleting the resource group. This cannot be undone.
#   ./infra/destroy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/infra/config.env"
[[ -f "$CONFIG" ]] || { echo "infra/config.env not found" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"

az account show >/dev/null 2>&1 || { echo "Not logged in. Run: az login" >&2; exit 1; }
if ! az group show -n "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Resource group $RESOURCE_GROUP does not exist; nothing to delete."
  exit 0
fi

echo "This permanently deletes resource group '$RESOURCE_GROUP' and everything in it:"
az resource list -g "$RESOURCE_GROUP" --query "[].{name:name, type:type}" -o table
read -r -p "Type the resource group name to confirm: " answer
[[ "$answer" == "$RESOURCE_GROUP" ]] || { echo "Cancelled."; exit 1; }

az group delete -n "$RESOURCE_GROUP" --yes --no-wait
# The next deploy starts from scratch with new names and secrets.
rm -f "$ROOT/infra/.deploy-state.env" "$ROOT/infra/cloud.env"
echo "Deletion started (it finishes in the background in a few minutes)."
