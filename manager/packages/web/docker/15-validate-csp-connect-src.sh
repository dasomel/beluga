#!/bin/sh
# Runs from nginx:alpine's /docker-entrypoint.d before 20-envsubst-on-templates.sh. The
# value is pasted verbatim into a CSP header inside a quoted nginx string, so anything beyond
# a plain source list (a `;`, a double quote, a newline) could add directives or break the
# config. Fail the container start instead of rendering it.
set -eu

token="('self'|https?://(\*\.)?[A-Za-z0-9.-]+(:[0-9]{1,5})?)"
value="${CSP_CONNECT_SRC:-}"

# grep matches per line, so reject embedded newlines first.
case "$value" in
  *'
'*) echo "CSP_CONNECT_SRC rejected: contains a newline" >&2; exit 1 ;;
esac

if ! printf '%s\n' "$value" | grep -Eq "^${token}( ${token})*\$"; then
  echo "CSP_CONNECT_SRC rejected: expected space-separated 'self' or http(s)://host[:port] sources" >&2
  exit 1
fi
