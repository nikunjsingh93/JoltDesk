#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22 or newer from https://nodejs.org, then run this launcher again.'
  exit 1
fi
if [ ! -d node_modules/electron/dist ]; then npm install --no-audit --no-fund; fi
npm start
