---
name: Replit Object Storage SDK sidecar pattern
description: @replit/object-storage SDK does NOT use REPLIT_DEFAULT_BUCKET_URL as an env var — it talks to a local sidecar at http://127.0.0.1:1106.
---

## The rule
Do NOT guard `getReplitClient()` with `REPLIT_DEFAULT_BUCKET_URL` — that env var is never injected by the platform. Use `REPLIT_CLUSTER` instead, which IS always present on Replit but absent in test/CI.

**Why:** The `@replit/object-storage` SDK resolves the bucket by calling `http://127.0.0.1:1106/object-storage/default-bucket` (a local sidecar process). Credentials also come from the sidecar (`/credential`, `/token`). The bucket config lives in `.replit` → `[objectStorage] defaultBucketID`, not in any injected env var. Guarding on `REPLIT_DEFAULT_BUCKET_URL` meant the client was always null on Replit, causing every PDF upload to fail with `storage_unavailable`.

**How to apply:**
- `getReplitClient()` guard: `if (!process.env.REPLIT_CLUSTER) return null;`
- Verify sidecar is live: `curl http://127.0.0.1:1106/object-storage/default-bucket` → `{"bucketId":"..."}` 
- The `blueprint:javascript_object_storage` integration is listed as `not_installed` but is NOT required for the `@replit/object-storage` npm package path — the bucket just needs to exist in `.replit`.
- `REPLIT_DEFAULT_BUCKET_URL` does not exist as an env var; remove it from `env.ts` schema.
