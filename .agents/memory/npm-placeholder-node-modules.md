---
name: npm placeholder node_modules
description: npm install can no-op when node_modules contains empty placeholder dirs
---
Rule: if a package binary (e.g. vite) is "not found" but `node_modules` exists, don't trust `npm install` alone — `rm -rf node_modules && npm install`.
**Why:** artifact dirs can be checked out with empty placeholder package directories; npm sees them as installed and skips real installation, so binaries in `.bin` never appear.
**How to apply:** any "command not found" for a dependency binary despite a populated-looking node_modules tree, especially in `artifacts/*` after merges/cold starts.
