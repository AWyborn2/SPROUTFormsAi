# @formai/mcp-inductions

An MCP server that exposes FormAI's CHC induction data to Claude Code — or any
other MCP client — so an agent can ask who is ready to be inducted, on which
Monday, how many seats to book, and can record the booking afterwards.

It does **not** drive BISTrainer. Registration stays browser-automated; this
server answers *who, when, how many* and remembers *what was booked*.

## Tools

| Tool | Answers |
| --- | --- |
| `list_induction_candidates` | Every starter with a readiness verdict and, when blocked, why |
| `get_induction_candidate` | One starter in full (sensitive fields on explicit request only) |
| `next_induction_dates` | The next bookable Mondays under the site's notice rule |
| `plan_induction_cohort` | Seat count and roster for one induction date |
| `record_induction_booking` | Records a completed booking; refuses to double-book |
| `list_induction_bookings` | What has already been booked |
| `get_induction_document_link` | A five-minute download link for a photo or licence image |

## Two transports

- **stdio** (`dist/index.js`) — for a client that can spawn a local process,
  such as Claude Code on your own machine. Configured with `FORMAI_API_URL`
  and `FORMAI_API_KEY`.
- **Streamable HTTP** (`./express`) — the same tools mounted on the API itself
  at `POST /mcp`, for hosted clients that cannot spawn anything locally. No
  build, no second deployment; authenticate with the same API key as a bearer
  token. See `docs/induction-mcp.md`.

## Setup

1. **Issue a key.** In FormAI, go to **API keys** and create one. Choose
   **Reviewer** for a booking agent — it can read inductions and record
   bookings. **Viewer** is read-only and cannot record a booking. The key is
   shown once.

2. **Build the server.**

   ```bash
   pnpm install
   pnpm --filter @formai/mcp-inductions build
   ```

3. **Register it with Claude Code.** Either add it to your project's
   `.mcp.json`:

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

   …or register it from the CLI:

   ```bash
   claude mcp add formai-inductions --env FORMAI_API_URL=https://your-formai-host/api --env FORMAI_API_KEY=fai_… -- node packages/mcp-inductions/dist/index.js
   ```

4. **Verify.** Ask the agent for the next induction dates. Dates coming back
   means the URL, the key and the permission grant are all correct.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `FORMAI_API_URL` | yes | Base URL of the FormAI API, e.g. `https://forms.example.com/api` |
| `FORMAI_API_KEY` | yes | An org-scoped API key issued in the app |

Both are checked at startup; a missing one exits immediately with a message
naming it, rather than letting the agent discover it as a stream of 401s.

## What the server can and cannot reach

A key reaches the induction endpoints only. It cannot manage the team, change
billing, edit forms, or alter submissions — that boundary is enforced by which
routers the machine credential is mounted on, not by a check that could be
forgotten.

Candidate payloads exclude date of birth, home address, licence number and
emergency contact by default. A caller can request them explicitly, and the
API returns them only if the key's role grants submission export. Identity
documents are reported as present/absent with a filename; the bytes are never
returned inline. `get_induction_document_link` mints a short-lived URL for the
cases that genuinely need the file, so the image is transferred rather than
carried through a model's context.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `unauthenticated (HTTP 401)` | The key is wrong, revoked, or from another workspace |
| `forbidden (HTTP 403)` on booking | The key's role lacks submission export — reissue as Reviewer |
| `already_booked (HTTP 409)` | That starter is already covered by a booking; re-read the candidates |
| `notice_override_required (HTTP 400)` | A starter is inside the notice window; ask the human, then pass `noticeOverrideReason` |
| Server exits at startup | `FORMAI_API_URL` or `FORMAI_API_KEY` is unset — the message names which |
