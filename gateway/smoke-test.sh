#!/usr/bin/env bash
# Gateway smoke test: calls the Tuition API only through Kong and checks status codes.
# Usage:  ./gateway/smoke-test.sh [gateway-url]        (default http://localhost:8000)
# Needs: the stack running and seeded (README §8). It does not change any data.
#
# The mobile rate limit is 3 calls per student per UTC day and is not reset between runs.
# To run the script again on the same day, restart Kong (docker compose restart kong; counters are
# kept in memory) or pick other students: MOBILE_STUDENT=20230010 OTHER_STUDENT=20230011 ./gateway/smoke-test.sh
set -uo pipefail

GATEWAY="${1:-http://localhost:8000}"
API="$GATEWAY/api/v1"
MOBILE_STUDENT="${MOBILE_STUDENT:-20230003}"
OTHER_STUDENT="${OTHER_STUDENT:-20230004}"
failures=0

# check <description> <expected status> <curl arguments...>
check() {
  local description="$1" expected="$2"
  shift 2
  local body status
  body="$(curl -s -w $'\n%{http_code}' "$@")"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  local mark="OK  "
  if [[ "$status" != "$expected" ]]; then
    mark="FAIL"
    failures=$((failures + 1))
  fi
  printf '%s %s  [expected %s, got %s]\n' "$mark" "$description" "$expected" "$status"
  # Tokens are masked so the output can be saved as evidence.
  body="$(printf '%s' "$body" | tr -d '\n' | sed -E 's/"accessToken":"[^"]+"/"accessToken":"<jwt>"/')"
  printf '     %s\n' "${body:0:240}"
}

login() {
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" |
    sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'
}

echo "Gateway: $GATEWAY"
echo "Time:    $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo
echo "== Public routes"
check "GET  /api/v1/health" 200 "$API/health"
check "GET  /api/docs-json (OpenAPI through the gateway)" 200 -o /dev/null "$GATEWAY/api/docs-json"
check "POST /api/v1/auth/login (student 20230001)" 200 -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"20230001","password":"Student#2026"}'
check "POST /api/v1/auth/login (wrong password)" 401 -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"20230001","password":"wrong"}'

STUDENT_TOKEN="$(login 20230001 'Student#2026')"
ADMIN_TOKEN="$(login admin 'Admin#2026')"

echo
echo "== Protected routes (JWT checked by Kong, then role and ownership by the API)"
check "GET  /api/v1/banking/tuition/20230001 without a token (Kong)" 401 "$API/banking/tuition/20230001"
check "GET  /api/v1/banking/tuition/20230001 with a tampered token (Kong)" 401 \
  -H "Authorization: Bearer ${STUDENT_TOKEN}x" "$API/banking/tuition/20230001"
check "GET  /api/v1/banking/tuition/20230001 own record" 200 \
  -H "Authorization: Bearer $STUDENT_TOKEN" "$API/banking/tuition/20230001"
check "GET  /api/v1/banking/tuition/20230002 another student's record (API)" 403 \
  -H "Authorization: Bearer $STUDENT_TOKEN" "$API/banking/tuition/20230002"
check "POST /api/v1/banking/payments amount above balance (nothing recorded)" 422 -X POST \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"studentNo":"20230001","term":"2026-FALL","amount":999999,"transactionId":"smoke-test-over-balance"}' \
  "$API/banking/payments"
check "GET  /api/v1/admin/tuition/unpaid with a student token (API)" 403 \
  -H "Authorization: Bearer $STUDENT_TOKEN" "$API/admin/tuition/unpaid?term=2026-FALL"
check "GET  /api/v1/admin/tuition/unpaid with an admin token" 200 \
  -H "Authorization: Bearer $ADMIN_TOKEN" "$API/admin/tuition/unpaid?term=2026-FALL&pageSize=2"

echo
echo "== Mobile Query Tuition: 3 calls per student per day (Kong rate-limiting, keyed by X-Student-No)"
for call in 1 2 3; do
  check "GET  /api/v1/mobile/tuition student $MOBILE_STUDENT, call $call" 200 \
    -H "X-Student-No: $MOBILE_STUDENT" "$API/mobile/tuition"
done
check "GET  /api/v1/mobile/tuition student $MOBILE_STUDENT, call 4" 429 \
  -H "X-Student-No: $MOBILE_STUDENT" "$API/mobile/tuition"
echo "     Response headers of call 5:"
curl -s -D - -o /dev/null -H "X-Student-No: $MOBILE_STUDENT" "$API/mobile/tuition" |
  grep -iE '^(HTTP|ratelimit|retry-after|x-ratelimit)' | sed 's/^/       /'
check "GET  /api/v1/mobile/tuition another student $OTHER_STUDENT (own counter)" 200 \
  -H "X-Student-No: $OTHER_STUDENT" "$API/mobile/tuition"

echo
echo "== Routing"
check "GET  /api/v2/health (no such version)" 404 "$GATEWAY/api/v2/health"
check "DELETE /api/v1/banking/payments (method not routed)" 404 -X DELETE "$API/banking/payments"

echo
if [[ $failures -eq 0 ]]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
fi
exit $((failures > 0))
