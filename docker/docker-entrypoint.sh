#!/bin/sh
# Runs as root to fix volume permissions, then drops to app user

DATA_DIR="/app/backend/data"

if [ -d "$DATA_DIR" ]; then
  chown -R app:app "$DATA_DIR"
fi

exec gosu app "$@"
