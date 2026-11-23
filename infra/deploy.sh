#!/usr/bin/env bash
# Deploys the Tuition API, the Kong gateway, the MCP server and PostgreSQL to Azure.
#
#   az login
#   cp infra/config.env.example infra/config.env     # adjust region or names if needed
#   ./infra/deploy.sh
#
# Safe to run again: existing resources are kept; an image is rebuilt only when its source files changed.
# Requirements: Azure CLI, openssl and a running Docker Desktop (images are built locally, see below).
# Resources: resource group, Container Registry (Basic), PostgreSQL Flexible Server (Burstable B1ms),
# Container Apps environment with four apps (API internal; Kong, MCP and the web chat public).
# The API applies the migrations and loads the demo data on its first start (SEED_ON_START, empty database only).
# The web chat needs GEMINI_API_KEY (taken from the environment or the local .env); without it, it is skipped.
# Secrets are generated on the first run, kept in infra/.deploy-state.env (not committed) and stored
# in Azure as Container Apps secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/infra/config.env"
STATE="$ROOT/infra/.deploy-state.env"
CLOUD_ENV="$ROOT/infra/cloud.env"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'echo; echo "Deployment stopped at line $LINENO. Fix the error above and run ./infra/deploy.sh again." >&2' ERR

# ---- Configuration -------------------------------------------------------------------------------
[[ -f "$CONFIG" ]] || fail "infra/config.env not found. Run: cp infra/config.env.example infra/config.env"
# shellcheck source=/dev/null
source "$CONFIG"
: "${RESOURCE_GROUP:?}" "${LOCATION:?}" "${NAME_PREFIX:?}" "${PG_ADMIN_USER:?}"
[[ "$NAME_PREFIX" =~ ^[a-z][a-z0-9]{2,11}$ ]] || fail "NAME_PREFIX must be 3-12 lowercase letters or digits"

command -v az >/dev/null || fail "Azure CLI (az) is not installed"
command -v openssl >/dev/null || fail "openssl is not installed"
az account show >/dev/null 2>&1 || fail "Not logged in. Run: az login"

# Generated once and reused, so a second run does not change passwords or names.
if [[ ! -f "$STATE" ]]; then
  (
    umask 077
    {
      echo "SUFFIX=$(openssl rand -hex 3)"
      echo "JWT_SECRET=$(openssl rand -hex 32)"
      echo "MCP_API_KEY=$(openssl rand -hex 24)"
      # Upper case, lower case and digits (PostgreSQL complexity rule) and URL-safe.
      echo "PG_PASSWORD=Tz$(openssl rand -hex 16)"
    } > "$STATE"
  )
fi
# shellcheck source=/dev/null
source "$STATE"

ACR_NAME="${NAME_PREFIX}acr${SUFFIX}"
PG_SERVER="${NAME_PREFIX}-pg-${SUFFIX}"
PG_DATABASE=tuition
ENV_NAME="${NAME_PREFIX}-env"
API_APP="${NAME_PREFIX}-api"
KONG_APP="${NAME_PREFIX}-gateway"
MCP_APP="${NAME_PREFIX}-mcp"
CHAT_APP="${NAME_PREFIX}-chat"
# Gemini settings for the web chat, from the environment or the local .env (the key is never printed).
env_value() { sed -n "s/^$1=//p" "$ROOT/.env" 2>/dev/null | head -n 1 || true; }
GEMINI_API_KEY="${GEMINI_API_KEY:-$(env_value GEMINI_API_KEY)}"
GEMINI_MODEL="${GEMINI_MODEL:-$(env_value GEMINI_MODEL)}"
GEMINI_FALLBACK_MODEL="${GEMINI_FALLBACK_MODEL:-$(env_value GEMINI_FALLBACK_MODEL)}"
DEPLOY_CHAT=true
if [[ -z "$GEMINI_API_KEY" || "$GEMINI_API_KEY" == "your-gemini-api-key" ]]; then
  DEPLOY_CHAT=false
  echo "Note: GEMINI_API_KEY is not set, so the web chat app is skipped."
fi

# Each image is tagged with a hash of its source files, so unchanged images are not rebuilt or redeployed.
content_tag() {
  (cd "$ROOT" && git ls-files -co --exclude-standard -- "$@" | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-12)
}
ROOT_FILES=(package.json package-lock.json tsconfig.base.json)
API_TAG="$(content_tag "${ROOT_FILES[@]}" apps/tuition-api)"
MCP_TAG="$(content_tag "${ROOT_FILES[@]}" apps/mcp-server)"
KONG_TAG="$(content_tag gateway)"
CHAT_TAG="$(content_tag "${ROOT_FILES[@]}" apps/agent)"

echo "Subscription:   $(az account show --query name -o tsv)"
echo "Resource group: $RESOURCE_GROUP ($LOCATION)"
echo "Image tags:     api $API_TAG, mcp $MCP_TAG, gateway $KONG_TAG, chat $CHAT_TAG"

app_exists() { az containerapp show -g "$RESOURCE_GROUP" -n "$1" >/dev/null 2>&1; }

# ---- Providers and resource group --------------------------------------------------------------
log "Registering resource providers and the Container Apps CLI extension (slow only the first time)"
for namespace in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL; do
  az provider register --namespace "$namespace" --wait -o none
done
# Installed only when missing: upgrading on every run downloads it again and can fail on a flaky network.
if ! az extension show --name containerapp >/dev/null 2>&1; then
  az extension add --name containerapp --only-show-errors -o none
fi

log "Resource group $RESOURCE_GROUP"
az group create -n "$RESOURCE_GROUP" -l "$LOCATION" -o none

# ---- Container registry and images -------------------------------------------------------------
log "Container registry $ACR_NAME"
if ! az acr show -g "$RESOURCE_GROUP" -n "$ACR_NAME" >/dev/null 2>&1; then
  az acr create -g "$RESOURCE_GROUP" -n "$ACR_NAME" -l "$LOCATION" --sku Basic --admin-enabled true -o none
fi
ACR_SERVER="$(az acr show -n "$ACR_NAME" --query loginServer -o tsv)"
ACR_USER="$(az acr credential show -n "$ACR_NAME" --query username -o tsv)"
ACR_PASSWORD="$(az acr credential show -n "$ACR_NAME" --query 'passwords[0].value' -o tsv)"
REGISTRY_ARGS=(--registry-server "$ACR_SERVER" --registry-username "$ACR_USER" --registry-password "$ACR_PASSWORD")

# Images are built for linux/amd64 (the Container Apps platform). Azure for Students subscriptions do not
# allow ACR Tasks, so by default they are built with the local Docker and pushed to the registry.
# Set IMAGE_BUILD=acr in infra/config.env to build in Azure instead (where ACR Tasks are allowed).
IMAGE_BUILD="${IMAGE_BUILD:-local}"
BUILT_IMAGES=()
build_image() {
  local image="$1" dockerfile="$2" context="$3"
  if az acr repository show -n "$ACR_NAME" --image "$image" >/dev/null 2>&1; then
    echo "$image is already in the registry (sources unchanged); not rebuilding it."
    return
  fi
  if [[ "$IMAGE_BUILD" == acr ]]; then
    az acr build -r "$ACR_NAME" -t "$image" -f "$dockerfile" "$context" --only-show-errors -o none
  else
    # One retry: package downloads inside an emulated amd64 build occasionally lose the connection.
    docker buildx build --platform linux/amd64 -t "$ACR_SERVER/$image" -f "$dockerfile" --push "$context" ||
      { echo "Build of $image failed; retrying once..."; docker buildx build --platform linux/amd64 -t "$ACR_SERVER/$image" -f "$dockerfile" --push "$context"; }
    BUILT_IMAGES+=("$ACR_SERVER/$image")
  fi
}

if [[ "$IMAGE_BUILD" == acr ]]; then
  log "Building images in Azure Container Registry (a few minutes)"
else
  log "Building images with local Docker (linux/amd64) and pushing them to $ACR_SERVER (several minutes)"
  command -v docker >/dev/null || PATH="$HOME/.docker/bin:$PATH"
  docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop and run the script again."
  az acr login -n "$ACR_NAME" --only-show-errors
fi
build_image "tuition-api:$API_TAG" "$ROOT/apps/tuition-api/Dockerfile" "$ROOT"
build_image "mcp-server:$MCP_TAG" "$ROOT/apps/mcp-server/Dockerfile" "$ROOT"
build_image "kong-gateway:$KONG_TAG" "$ROOT/gateway/Dockerfile" "$ROOT/gateway"
if [[ "$DEPLOY_CHAT" == true ]]; then
  build_image "chat-web:$CHAT_TAG" "$ROOT/apps/agent/Dockerfile" "$ROOT"
fi
if [[ ${#BUILT_IMAGES[@]} -gt 0 ]]; then
  # The images now live in the registry; free the local disk space.
  docker image rm "${BUILT_IMAGES[@]}" >/dev/null 2>&1 || true
  docker builder prune -f >/dev/null 2>&1 || true
fi

# ---- PostgreSQL --------------------------------------------------------------------------------
log "PostgreSQL Flexible Server $PG_SERVER (Burstable B1ms; creating it takes 5-10 minutes)"
if ! az postgres flexible-server show -g "$RESOURCE_GROUP" -n "$PG_SERVER" >/dev/null 2>&1; then
  # --public-access 0.0.0.0 allows connections from Azure services only (no other public IPs).
  az postgres flexible-server create -g "$RESOURCE_GROUP" -n "$PG_SERVER" -l "$LOCATION" \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
    --admin-user "$PG_ADMIN_USER" --admin-password "$PG_PASSWORD" \
    --public-access 0.0.0.0 --yes -o none
fi
if ! az postgres flexible-server db show -g "$RESOURCE_GROUP" -s "$PG_SERVER" -n "$PG_DATABASE" >/dev/null 2>&1; then
  az postgres flexible-server db create -g "$RESOURCE_GROUP" -s "$PG_SERVER" -n "$PG_DATABASE" -o none
fi
DATABASE_URL="postgresql://${PG_ADMIN_USER}:${PG_PASSWORD}@${PG_SERVER}.postgres.database.azure.com:5432/${PG_DATABASE}?schema=public&sslmode=require"

# ---- Container Apps environment ----------------------------------------------------------------
log "Container Apps environment $ENV_NAME"
# The environment must use workload profiles (Consumption profile). Newer CLI versions may otherwise create an
# "Express" environment, which has no service-to-service traffic to internal apps and no jobs.
ENV_MODE="$(az containerapp env show -g "$RESOURCE_GROUP" -n "$ENV_NAME" --query properties.environmentMode -o tsv 2>/dev/null || true)"
if [[ "$ENV_MODE" == "Express" ]]; then
  if [[ "${RECREATE_ENV:-false}" != true ]]; then
    fail "Environment $ENV_NAME is an Express environment, where Kong cannot reach the internal API.
Run again with RECREATE_ENV=true to delete its apps and the environment and create them again
(the database, registry and secrets are kept):  RECREATE_ENV=true ./infra/deploy.sh"
  fi
  echo "Deleting the Express environment and its apps (RECREATE_ENV=true)..."
  for app in $(az containerapp list -g "$RESOURCE_GROUP" --query "[?properties.managedEnvironmentId && ends_with(properties.managedEnvironmentId, '/$ENV_NAME')].name" -o tsv); do
    az containerapp delete -g "$RESOURCE_GROUP" -n "$app" --yes -o none
  done
  az containerapp env delete -g "$RESOURCE_GROUP" -n "$ENV_NAME" --yes -o none
  ENV_MODE=""
fi
if [[ -z "$ENV_MODE" ]]; then
  az containerapp env create -g "$RESOURCE_GROUP" -n "$ENV_NAME" -l "$LOCATION" \
    --environment-mode WorkloadProfiles -o none
fi

# ---- Tuition API (internal: reachable only from inside the environment, i.e. from Kong) ---------
log "Tuition API app $API_APP (internal ingress)"
API_SECRETS=(jwt-secret="$JWT_SECRET" database-url="$DATABASE_URL")
API_ENV=(JWT_SECRET=secretref:jwt-secret DATABASE_URL=secretref:database-url PORT=3000 JWT_EXPIRES_IN=1h SEED_ON_START=true)
if app_exists "$API_APP"; then
  az containerapp secret set -g "$RESOURCE_GROUP" -n "$API_APP" --secrets "${API_SECRETS[@]}" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$API_APP" --image "$ACR_SERVER/tuition-api:$API_TAG" \
    --set-env-vars "${API_ENV[@]}" -o none
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$API_APP" --environment "$ENV_NAME" \
    --image "$ACR_SERVER/tuition-api:$API_TAG" "${REGISTRY_ARGS[@]}" \
    --ingress internal --target-port 3000 --min-replicas 0 --max-replicas 2 --cpu 0.5 --memory 1.0Gi \
    --secrets "${API_SECRETS[@]}" --env-vars "${API_ENV[@]}" -o none
fi
# Address of the internal API inside the environment. Some environments (for example the Express
# environments of Azure for Students) report the FQDN without ".internal", which only works from outside.
ENV_DOMAIN="$(az containerapp env show -g "$RESOURCE_GROUP" -n "$ENV_NAME" --query properties.defaultDomain -o tsv)"
API_FQDN="${API_APP}.internal.${ENV_DOMAIN}"

# ---- Kong gateway (public; exactly one replica so the in-memory rate-limit counters are exact) -
log "Kong gateway app $KONG_APP (external ingress, 1 replica)"
KONG_ENV=(
  JWT_SECRET=secretref:jwt-secret
  "UPSTREAM_URL=https://$API_FQDN"
  KONG_NGINX_WORKER_PROCESSES=1
  KONG_MEM_CACHE_SIZE=64m
  # Requests reach Kong through the Container Apps ingress; take the client IP from X-Forwarded-For.
  "KONG_TRUSTED_IPS=0.0.0.0/0,::/0"
  KONG_REAL_IP_HEADER=X-Forwarded-For
)
if app_exists "$KONG_APP"; then
  az containerapp secret set -g "$RESOURCE_GROUP" -n "$KONG_APP" --secrets jwt-secret="$JWT_SECRET" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$KONG_APP" --image "$ACR_SERVER/kong-gateway:$KONG_TAG" \
    --set-env-vars "${KONG_ENV[@]}" -o none
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$KONG_APP" --environment "$ENV_NAME" \
    --image "$ACR_SERVER/kong-gateway:$KONG_TAG" "${REGISTRY_ARGS[@]}" \
    --ingress external --target-port 8000 --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets jwt-secret="$JWT_SECRET" --env-vars "${KONG_ENV[@]}" -o none
fi
KONG_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$KONG_APP" --query properties.configuration.ingress.fqdn -o tsv)"

# ---- MCP server (public, protected by x-api-key; not behind the gateway) -----------------------
log "MCP server app $MCP_APP (external ingress)"
MCP_ENV=(MCP_API_KEY=secretref:mcp-api-key PORT=3001)
if app_exists "$MCP_APP"; then
  az containerapp secret set -g "$RESOURCE_GROUP" -n "$MCP_APP" --secrets mcp-api-key="$MCP_API_KEY" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$MCP_APP" --image "$ACR_SERVER/mcp-server:$MCP_TAG" \
    --set-env-vars "${MCP_ENV[@]}" -o none
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$MCP_APP" --environment "$ENV_NAME" \
    --image "$ACR_SERVER/mcp-server:$MCP_TAG" "${REGISTRY_ARGS[@]}" \
    --ingress external --target-port 3001 --min-replicas 0 --max-replicas 2 --cpu 0.25 --memory 0.5Gi \
    --secrets mcp-api-key="$MCP_API_KEY" --env-vars "${MCP_ENV[@]}" -o none
fi
MCP_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$MCP_APP" --query properties.configuration.ingress.fqdn -o tsv)"

# ---- Web chat (public; the agent runs here, so the browser never sees the Gemini or MCP key) ----
CHAT_FQDN=""
if [[ "$DEPLOY_CHAT" == true ]]; then
  log "Web chat app $CHAT_APP (external ingress, 1 replica: sessions are kept in memory)"
  CHAT_SECRETS=(gemini-api-key="$GEMINI_API_KEY" mcp-api-key="$MCP_API_KEY")
  CHAT_ENV=(
    PORT=8080
    CHAT_SECURE_COOKIES=true
    "GATEWAY_URL=https://$KONG_FQDN"
    "MCP_URL=https://$MCP_FQDN/mcp"
    MCP_API_KEY=secretref:mcp-api-key
    GEMINI_API_KEY=secretref:gemini-api-key
    "GEMINI_MODEL=${GEMINI_MODEL:-gemini-3.8-flash}"
    "GEMINI_FALLBACK_MODEL=${GEMINI_FALLBACK_MODEL:-gemini-3.6-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.1-flash-lite}"
  )
  if app_exists "$CHAT_APP"; then
    az containerapp secret set -g "$RESOURCE_GROUP" -n "$CHAT_APP" --secrets "${CHAT_SECRETS[@]}" -o none
    az containerapp update -g "$RESOURCE_GROUP" -n "$CHAT_APP" --image "$ACR_SERVER/chat-web:$CHAT_TAG" \
      --set-env-vars "${CHAT_ENV[@]}" -o none
  else
    az containerapp create -g "$RESOURCE_GROUP" -n "$CHAT_APP" --environment "$ENV_NAME" \
      --image "$ACR_SERVER/chat-web:$CHAT_TAG" "${REGISTRY_ARGS[@]}" \
      --ingress external --target-port 8080 --min-replicas 0 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
      --secrets "${CHAT_SECRETS[@]}" --env-vars "${CHAT_ENV[@]}" -o none
  fi
  CHAT_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$CHAT_APP" --query properties.configuration.ingress.fqdn -o tsv)"
fi

# ---- Result ------------------------------------------------------------------------------------
(
  umask 077
  {
    echo "# Written by infra/deploy.sh; not committed. Load with: set -a; source infra/cloud.env; set +a"
    echo "GATEWAY_URL=https://$KONG_FQDN"
    echo "MCP_URL=https://$MCP_FQDN/mcp"
    echo "MCP_API_KEY=$MCP_API_KEY"
    if [[ -n "$CHAT_FQDN" ]]; then echo "CHAT_URL=https://$CHAT_FQDN"; fi
  } > "$CLOUD_ENV"
)

log "Deployment finished"
cat <<EOF
Gateway (all REST operations): https://$KONG_FQDN
  Swagger UI:                  https://$KONG_FQDN/api/docs
MCP server:                    https://$MCP_FQDN/mcp   (header x-api-key, value in infra/cloud.env)
Tuition API (internal only):   https://$API_FQDN
Web chat:                      $(if [[ -n "$CHAT_FQDN" ]]; then echo "https://$CHAT_FQDN"; else echo "skipped (no GEMINI_API_KEY)"; fi)

Next steps:
  ./gateway/smoke-test.sh https://$KONG_FQDN
  set -a; source infra/cloud.env; set +a
  npm run demo -w apps/mcp-server
  npm run start -w apps/agent

The first request after an idle period can take 10-30 s while the API and MCP containers start.
EOF
