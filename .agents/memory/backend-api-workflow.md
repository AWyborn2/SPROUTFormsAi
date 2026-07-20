---
name: Backend API workflow fix
description: The Backend API workflow was self-referencing and must use configureWorkflow to fix.
---

## Rule
The Backend API workflow must be configured via `configureWorkflow()` (the workflows skill's code_execution callback), not by editing `.replit` directly (that file is protected).

## What was wrong
The workflow had `task = "workflow.run" / args = "Backend API"` — it called itself recursively, causing a TASK_FAILED loop.

## Fix
```javascript
await configureWorkflow({
    name: "Backend API",
    command: "API_PORT=8000 pnpm dev:api",
    waitForPort: 8000,
    outputType: "console"
});
```

**Why:** `.replit` is write-protected; `configureWorkflow` is the correct tool for workflow setup. Always use it when workflows need creation or reconfiguration.
