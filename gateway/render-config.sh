#!/usr/bin/env bash
# Renders the declarative config with the JWT secret, then starts Kong with the image's own entrypoint.
# The secret comes from the JWT_SECRET environment variable and is never stored in the repository.
set -euo pipefail
# Bash 5.2+ would expand "&" in a ${var//pattern/replacement} replacement; the secret must be copied literally.
shopt -u patsub_replacement 2>/dev/null || true

TEMPLATE=/kong/kong.yml
RENDERED="${KONG_DECLARATIVE_CONFIG:-/tmp/kong.yml}"

if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "render-config: JWT_SECRET is not set" >&2
  exit 1
fi

# Address of the Tuition API service as seen from Kong.
UPSTREAM_URL="${UPSTREAM_URL:-http://tuition-api:3000}"
if [[ ! "$UPSTREAM_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "render-config: UPSTREAM_URL must look like http://host[:port], got '$UPSTREAM_URL'" >&2
  exit 1
fi

# The secret sits inside a single-quoted YAML string, where a single quote is written as two.
escaped="${JWT_SECRET//\'/\'\'}"
content="$(<"$TEMPLATE")"
content="${content//__UPSTREAM_URL__/$UPSTREAM_URL}"
printf '%s\n' "${content//__JWT_SECRET__/$escaped}" > "$RENDERED"
chmod 600 "$RENDERED"

exec /docker-entrypoint.sh "$@"
