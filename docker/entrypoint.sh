#!/bin/sh
set -eu

persist_dir="${PERSIST_DIR:-/data}"
database_name="${D1_DATABASE_NAME:-hrt-tracker-prod}"
port="${PORT:-8787}"

mkdir -p "$persist_dir"

# The single-user migration is idempotent and never drops existing data.
./node_modules/.bin/wrangler d1 execute "$database_name" \
    --local \
    --persist-to "$persist_dir" \
    --file ./migrations/0001_single_user.sql \
    --yes

set -- ./node_modules/.bin/wrangler dev \
    --ip 0.0.0.0 \
    --port "$port" \
    --persist-to "$persist_dir"

exec "$@"
