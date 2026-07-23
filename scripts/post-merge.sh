#!/bin/bash
set -e

pnpm install --frozen-lockfile
pnpm db:migrate
npm install --prefix artifacts/mockup-sandbox
