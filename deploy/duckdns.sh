#!/usr/bin/env bash
# Point a DuckDNS name at this machine's current public IP address.
# Usage: DUCKDNS_DOMAIN=yourteam DUCKDNS_TOKEN=xxxxxxxx deploy/duckdns.sh
# (DUCKDNS_DOMAIN is the part before .duckdns.org.) Run it from cron every 5 minutes so the
# name follows the VM if its address changes.
set -euo pipefail

: "${DUCKDNS_DOMAIN:?Set DUCKDNS_DOMAIN (the part before .duckdns.org)}"
: "${DUCKDNS_TOKEN:?Set DUCKDNS_TOKEN (shown on duckdns.org after signing in)}"

# An empty ip= tells DuckDNS to use the address the request came from.
result="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")"
if [ "$result" != "OK" ]; then
  echo "DuckDNS update failed: $result" >&2
  exit 1
fi
