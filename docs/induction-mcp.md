# Induction MCP — operator guide

How to connect an agent to FormAI's induction data, end to end. Ten minutes,
mostly waiting for a build.

The agent gets a read of who is ready to be inducted and a place to record what
it booked. It does not get access to anything else in the workspace.

---

## 1. Issue a key

In FormAI: **API keys** in the left nav → **New key**.

- **Name** — something you will recognise in an audit log six months from now,
  e.g. `Induction booking agent`.
- **Role** — **Reviewer** for an agent that books; it can read inductions and
  record bookings. **Viewer** if you only want it to look.

The key is displayed once. Copy it straight into step 3; if you lose it, revoke
it and create another rather than hunting for it.

An owner or admin can issue keys. Nobody can issue a key more powerful than
their own role, and a key can never issue or revoke keys itself.

---

## 2. Build the server

From the repository root:

```bash
pnpm install
```

```bash
pnpm --filter @formai/mcp-inductions build
```

---

## 3. Point Claude Code at it

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "formai-inductions": {
      "command": "node",
      "args": ["packages/mcp-inductions/dist/index.js"],
      "env": {
        "FORMAI_API_URL": "https://your-formai-host/api",
        "FORMAI_API_KEY": "fai_…"
      }
    }
  }
}
```

The server runs on **your machine**, not on the deployment. It only needs to be
able to reach the API over the network — the same URL your browser uses, plus
`/api` if your deployment serves the API under a path.

---

## 4. Verify

Ask the agent: *"What are the next induction dates?"*

You should get Mondays, four or more clear business days out, with public
holidays skipped. If instead you see:

- **`unauthenticated`** — the key is wrong, revoked, or belongs to another
  workspace.
- **the server exiting at startup** — one of the two environment variables is
  unset; the message says which.
- **`forbidden`** when recording a booking — the key is a Viewer. Reissue it as
  a Reviewer.

---

## What the agent can see

Candidate payloads carry what a booking needs: name, mobile, email, induction
date, department, roles, and whether the photo and licence documents exist.

They do **not** carry date of birth, home address, licence number, or emergency
contact unless a caller asks for them explicitly *and* the key's role grants
submission export. Identity document bytes are never returned — only presence
and a filename.

This default is deliberate: these responses land in a model's context window,
which may be logged outside this system, and a booking demonstrably does not
need those fields.

## What the agent cannot do

The key reaches induction endpoints only. Team management, billing, form
editing, and submission changes are session-only surfaces. That is enforced by
which routers accept a machine credential, so it cannot be widened by
forgetting a permission check.

---

## The workflow it supports

1. `list_induction_candidates` — who has requested an induction, and who is
   blocked. A blocked starter is fixed in the intake form, not worked around.
2. `plan_induction_cohort` — for a chosen Monday, the seat count and the roster.
   **Seats count ready starters only**; blocked starters appear in the roster
   but must not be given a seat.
3. Book the seats in BISTrainer (browser automation — outside this server).
4. `record_induction_booking` — record what was booked, with the BISTrainer
   reference. Those starters then show as `already_booked`, so a second run
   cannot book them again.

## Known limitation: the public-holiday list

The notice rule skips WA public holidays from a stored list that currently ends
**2026-12-28**. Past that date the rule silently treats a holiday as a working
day, which could allow a booking with too little real notice.

The API does not hide this: any date beyond the list is returned with
`holidayListExpired: true`, and candidates carry a `holiday_list_expired`
warning. Extend `CHC_PUBLIC_HOLIDAYS` in `packages/shared/src/chc-intake.ts`
when the next year's dates are published.
