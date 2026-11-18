#!/usr/bin/env bash
# Deploys the Tuition API, the Kong gateway, the MCP server and PostgreSQL to Azure.
#
#   az login
#   cp infra/config.env.example infra/config.env     # adjust region or names if needed
#   ./infra/deploy.sh
#
# Safe to run again: existing resources are kept and the container images are rebuilt and updated.
# Resources: resource group, Container Registry (Basic), PostgreSQL Flexible Server (Burstable B1ms),
# Container Apps environment with three apps (API internal, Kong and MCP public) and a seed job.
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
SEED_JOB="${NAME_PREFIX}-seed"
TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo build)-$(date +%Y%m%d%H%M%S)"

echo "Subscription:   $(az account show --query name -o tsv)"
echo "Resource group: $RESOURCE_GROUP ($LOCATION)"
echo "Image tag:      $TAG"

app_exists() { az containerapp show -g "$RESOURCE_GROUP" -n "$1" >/dev/null 2>&1; }

# ---- Providers and resource group --------------------------------------------------------------
log "Registering resource providers and the Container Apps CLI extension (slow only the first time)"
for namespace in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL; do
  az provider register --namespace "$namespace" --wait -o none
done
az extension add --name containerapp --upgrade --only-show-errors -o none

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

# Images are built in Azure (linux/amd64), so nothing is built or pushed from this machine.
log "Building images in Azure Container Registry (a few minutes)"
az acr build -r "$ACR_NAME" -t "tuition-api:$TAG" -f "$ROOT/apps/tuition-api/Dockerfile" "$ROOT" --only-show-errors -o none
az acr build -r "$ACR_NAME" -t "mcp-server:$TAG" -f "$ROOT/apps/mcp-server/Dockerfile" "$ROOT" --only-show-errors -o none
az acr build -r "$ACR_NAME" -t "kong-gateway:$TAG" "$ROOT/gateway" --only-show-errors -o none

# ---- PostgreSQL --------------------------------------------------------------------------------
log "PostgreSQL Flexible Server $PG_SERVER (Burstable B1ms; creating it takes 5-10 minutes)"
if ! az postgres flexible-server show -g "$RESOURCE_GROUP" -n "$PG_SERVER" >/dev/null 2>&1; then
  # --public-access 0.0.0.0 allows connections from Azure services only (no other public IPs).
  az postgres flexible-server create -g "$RESOURCE_GROUP" -n "$PG_SERVER" -l "$LOCATION" \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
    --admin-user "$PG_ADMIN_USER" --admin-password "$PG_PASSWORD" \
    --public-access 0.0.0.0 --high-availability Disabled --yes -o none
fi
if ! az postgres flexible-server db show -g "$RESOURCE_GROUP" -s "$PG_SERVER" -d "$PG_DATABASE" >/dev/null 2>&1; then
  az postgres flexible-server db create -g "$RESOURCE_GROUP" -s "$PG_SERVER" -d "$PG_DATABASE" -o none
fi
DATABASE_URL="postgresql://${PG_ADMIN_USER}:${PG_PASSWORD}@${PG_SERVER}.postgres.database.azure.com:5432/${PG_DATABASE}?schema=public&sslmode=require"

# ---- Container Apps environment ----------------------------------------------------------------
log "Container Apps environment $ENV_NAME"
if ! az containerapp env show -g "$RESOURCE_GROUP" -n "$ENV_NAME" >/dev/null 2>&1; then
  az containerapp env create -g "$RESOURCE_GROUP" -n "$ENV_NAME" -l "$LOCATION" -o none
fi

# ---- Tuition API (internal: reachable only from inside the environment, i.e. from Kong) ---------
log "Tuition API app $API_APP (internal ingress)"
API_SECRETS=(jwt-secret="$JWT_SECRET" database-url="$DATABASE_URL")
API_ENV=(JWT_SECRET=secretref:jwt-secret DATABASE_URL=secretref:database-url PORT=3000 JWT_EXPIRES_IN=1h)
if app_exists "$API_APP"; then
  az containerapp secret set -g "$RESOURCE_GROUP" -n "$API_APP" --secrets "${API_SECRETS[@]}" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$API_APP" --image "$ACR_SERVER/tuition-api:$TAG" \
    --set-env-vars "${API_ENV[@]}" -o none
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$API_APP" --environment "$ENV_NAME" \
    --image "$ACR_SERVER/tuition-api:$TAG" "${REGISTRY_ARGS[@]}" \
    --ingress internal --target-port 3000 --min-replicas 0 --max-replicas 2 --cpu 0.5 --memory 1.0Gi \
    --secrets "${API_SECRETS[@]}" --env-vars "${API_ENV[@]}" -o none
fi
API_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$API_APP" --query properties.configuration.ingress.fqdn -o tsv)"

# ---- Seed job: applies migrations and loads the demo data ----------------------------------------
log "Seed job $SEED_JOB (migrations + demo data)"
if az containerapp job show -g "$RESOURCE_GROUP" -n "$SEED_JOB" >/dev/null 2>&1; then
  az containerapp job secret set -g "$RESOURCE_GROUP" -n "$SEED_JOB" --secrets database-url="$DATABASE_URL" -o none
  az containerapp job update -g "$RESOURCE_GROUP" -n "$SEED_JOB" --image "$ACR_SERVER/tuition-api:$TAG" -o none
else
  az containerapp job create -g "$RESOURCE_GROUP" -n "$SEED_JOB" --environment "$ENV_NAME" \
    --trigger-type Manual --replica-timeout 900 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 \
    --image "$ACR_SERVER/tuition-api:$TAG" "${REGISTRY_ARGS[@]}" --cpu 0.5 --memory 1.0Gi \
    --secrets database-url="$DATABASE_URL" --env-vars DATABASE_URL=secretref:database-url \
    --command npm --args run db:setup -o none
fi
EXECUTION="$(az containerapp job start -g "$RESOURCE_GROUP" -n "$SEED_JOB" --query name -o tsv)"
echo "Started $EXECUTION, waiting for it to finish..."
for _ in $(seq 1 60); do
  STATUS="$(az containerapp job execution show -g "$RESOURCE_GROUP" -n "$SEED_JOB" --job-execution-name "$EXECUTION" --query properties.status -o tsv)"
  [[ "$STATUS" == "Succeeded" || "$STATUS" == "Failed" ]] && break
  sleep 10
done
[[ "$STATUS" == "Succeeded" ]] || fail "Seed job ended with status '$STATUS'. Logs: az containerapp job logs show -g $RESOURCE_GROUP -n $SEED_JOB --execution $EXECUTION --container $SEED_JOB"
echo "Seed job succeeded."

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
  az containerapp update -g "$RESOURCE_GROUP" -n "$KONG_APP" --image "$ACR_SERVER/kong-gateway:$TAG" \
    --set-env-vars "${KONG_ENV[@]}" -o none
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$KONG_APP" --environment "$ENV_NAME" \
    --image "$ACR_SERVER/kong-gateway:$TAG" "${REGISTRY_ARGS[@]}" \
    --ingress external --target-port 8000 --min-replicas 1 --max-replicas 1 --cpu 0.25 --memory 0.5Gi \
    --secrets jwt-secret="$JWT_SECRET" --env-vars "${KONG_ENV[@]}" -o none
fi
KONG_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$KONG_APP" --query properties.configuration.ingress.fqdn -o tsv)"

# ---- MCP server (public, protected by x-api-key; not behind the gateway) -----------------------
log "MCP server app $MCP_APP (external ingress)"
MCP_ENV=(MCP_API_KEY=secretref:mcp-api-key PORT=3001)
if app_exists "$MCP_APP"; then
  az containerapp secret set -g "$RESOURCE_GROUP" -n "$MCP_APP" --secrets mcp-api-key="$MCP_API_KEY" -o none
  az containerapp update -g "$RESOURCE_GROUP" -n "$MCP_APP" --image "$ACR_SERVER/mcp-server:$TAG" \
    --set-env-vars "${MCP_ENV[@]}" -o none
else
  az containerapp create -g "$RESOURCE_GROUP" -n "$MCP_APP" --environment "$ENV_NAME" \
    --image "$ACR_SERVER/mcp-server:$TAG" "${REGISTRY_ARGS[@]}" \
    --ingress external --target-port 3001 --min-replicas 0 --max-replicas 2 --cpu 0.25 --memory 0.5Gi \
    --secrets mcp-api-key="$MCP_API_KEY" --env-vars "${MCP_ENV[@]}" -o none
fi
MCP_FQDN="$(az containerapp show -g "$RESOURCE_GROUP" -n "$MCP_APP" --query properties.configuration.ingress.fqdn -o tsv)"

# ---- Result ------------------------------------------------------------------------------------
(
  umask 077
  {
    echo "# Written by infra/deploy.sh; not committed. Load with: set -a; source infra/cloud.env; set +a"
    echo "GATEWAY_URL=https://$KONG_FQDN"
    echo "MCP_URL=https://$MCP_FQDN/mcp"
    echo "MCP_API_KEY=$MCP_API_KEY"
  } > "$CLOUD_ENV"
)

log "Deployment finished"
cat <<EOF
Gateway (all REST operations): https://$KONG_FQDN
  Swagger UI:                  https://$KONG_FQDN/api/docs
MCP server:                    https://$MCP_FQDN/mcp   (header x-api-key, value in infra/cloud.env)
Tuition API (internal only):   https://$API_FQDN

Next steps:
  ./gateway/smoke-test.sh https://$KONG_FQDN
  set -a; source infra/cloud.env; set +a
  npm run demo -w apps/mcp-server
  npm run start -w apps/agent

The first request after an idle period can take 10-30 s while the API and MCP containers start.
EOF
