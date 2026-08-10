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

## 2. Build the server (stdio only)

Skip this if you are connecting a hosted client over HTTP — that path needs no
local build. For a local Claude Code setup, from the repository root:

```bash
pnpm install
```

```bash
pnpm --filter @formai/mcp-inductions build
```

---

## 3. Connect a client

There are two transports, and which one you can use depends on where the client
runs.

### Local client (Claude Code on your machine) — stdio

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "formai-inductions": {
      "command": "node",
      "args": ["packages/mcp-inductions/dist/index.js"],
      "env": {
        "FORMAI_API_URL": "https://your-formai-host/api",
        "FORMAI_API_KEY": "fai_..."
      }
    }
  }
}
```

`FORMAI_API_URL` is the **API** base, not a page you can open in a browser. On a
Replit deployment that is your app's host plus `/api` — the web server proxies
`/api` through to the API process. Getting this wrong is quiet rather than
loud: a page URL answers `200` with HTML, which is not an error.

The server runs on **your machine**, not on the deployment. It only needs to be
able to reach the API over the network.

### Hosted client (Cowork, or anything not on your machine) — HTTP

A hosted client cannot spawn a local process, so stdio is not an option. The
same tools are served over Streamable HTTP at `/mcp` on the API itself:

```
https://your-formai-host/api/mcp
```

Authenticate with the same API key as a bearer token:

```
Authorization: Bearer fai_...
```

There is nothing to install, build, or deploy for this path — if the API is
running, the endpoint is live. Point the client at that URL, give it the key,
and it gets the identical toolset.

### Claude's custom-connector dialog — the key goes in the URL

Claude's **Add custom connector** dialog takes a name, a URL, and optional OAuth
credentials. There is nowhere to put a bearer token, so the header form above
cannot be used there. For that dialog only, the same tools are served with the
key as a path segment:

```
https://your-formai-host/api/mcp/key/fai_...
```

Paste that as the **Remote MCP server URL** and leave the OAuth fields empty.

It is the **same credential**: same role, same audit trail, and revoking the key
in the app kills the connector immediately. What differs is where the key
travels. A URL is visible to proxies, access logs, and whatever stores the
connector configuration, in a way an `Authorization` header is not — so prefer
the header form for anything that can send one, and treat a connector URL as
the secret it is. If one is ever exposed, revoke that key and issue another;
that is the mitigation, and it takes one click.

Two things worth knowing about how it behaves:

- **It is stateless.** Every request stands alone and carries its own key, so
  there are no sessions to expire and no server state shared between callers.
  `GET /api/mcp` answers `405`; the endpoint takes `POST` only.
- **A bad key fails immediately.** The key is checked before the MCP handshake,
  so a revoked or wrong credential comes back as `401` rather than as a
  confusing tool failure several round trips later.

## 4. Verify

Ask the agent: *"What are the next induction dates?"*

For the HTTP endpoint you can check it without a client at all:

```bash
curl -s -X POST https://your-formai-host/api/mcp   -H "Authorization: Bearer fai_..."   -H "content-type: application/json"   -H "accept: application/json, text/event-stream"   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

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

## Photos and licence images

Candidate payloads report a document as presence plus metadata —
`{ present: true, fileName: "marlee.jpg", contentType: "image/jpeg" }` — never
the bytes and never the storage key. The agent can tell you a photo exists; it
cannot see it.

When a task genuinely needs the file, such as building a BISTrainer profile,
`get_induction_document_link` mints a **download link that expires in five
minutes**. The agent fetches that URL and transfers the file. The image never
passes through the model's context, so it never lands in a transcript.

Three things about those links:

- **The link is the credential.** Anyone holding it can fetch the file until it
  expires, so it should be used and discarded, not pasted into a chat log or a
  ticket.
- **Minting one needs the export grant.** A Viewer key can see that a photo
  exists and go no further; a Reviewer key can mint the link.
- **Every issue is audited** under the `security` category, naming the file.
  A document leaving the system is a security event, and the log says so.

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
5. `confirm_induction_booking` — after the human's pre-induction check, record
   that the booking stands. See below.

## Confirming a booking

A recorded booking is **tentative**. The seat exists in BISTrainer, but whether
the starter will actually be ready on the day is settled by a human check close
to the induction — at CHC, the 2pm Thursday gate check before the Monday. The
product stores the *result* of that check, never its substance: what gets
verified is the operator's own checklist, outside this system.

- Each starter seat carries `confirmedAt` (and who confirmed it, in the audit
  log). A booking's `confirmed` flag is true only when **every** seat on it is
  confirmed — a cohort can be partially ready, and the flag will say so.
- `confirm_induction_booking` takes the booking id, and optionally
  `submissionIds` to confirm a subset of seats.
- It is **idempotent**: confirming an already-confirmed seat keeps the first
  timestamp and reports the seat under `alreadyConfirmed`, so a retried call is
  a no-op rather than an error.
- Every confirmation writes an audit entry naming the booking date and the
  starters confirmed, in the same shape as the booking-write entry.

One rule matters more than the mechanics: **confirmation records a human
decision.** An agent must never call the tool because a booking looks ready or
to tidy a list. If no human has said "confirmed", the booking stays
unconfirmed — and that is the accurate record, which is exactly what lets a
watchdog chase the check before the deadline instead of after it.

## Overriding the notice rule

A starter inside the four-business-day window shows as `date_notice_lapsed` and
holds no seat. When the site agrees to take them anyway, pass `allowLateNotice`
on the candidate or cohort read: they read as ready, carry a
`notice_overridden` warning, and count toward the seat total.

Recording that booking then **requires** `noticeOverrideReason`. The API
refuses without one, stores it beside the booking, and writes an audit entry
naming the waiver. So the exception lives in the record instead of somebody's
memory — which is the whole reason the override is allowed to exist rather than
being something people work around by editing the form.

The override is narrow on purpose. It waives *lead time*, nothing else. A date
that is not a Monday, or is a public holiday, stays blocked no matter what
flag you pass: those are days on which no induction runs, and no authority
makes one appear.

## When the form never asked

The intake ships as an ordinary editable template, so an administrator can add,
rename or re-create its questions in the builder. Two consequences reach this
server, and both are now reported rather than silent:

- **A re-created question keeps working.** The builder assigns its own id to a
  question you add or delete-and-recreate, so the preset's id is gone. Choice
  questions are recognised by their option list instead, which is the part you
  reproduce exactly when you rebuild one. This is what stops a re-created
  **Ethnicity** dropdown reading as blank, and a re-created **Department**
  dropping the starter from these tools altogether.

- **A question the version does not ask is named, not blanked.** Anything the
  starter's form version never carried is listed in `starter.notCollected`, and
  the candidate carries an `intake_incomplete` warning. Those fields come back
  empty because nobody was asked — not because the starter skipped them.

The distinction matters at registration time. An empty ethnicity that was never
asked must not be carried into BISTrainer as `Unknown` or anything else: that
records a fact about a person that nobody stated. Add the question to the intake
form and have the starter answer it.

The warning never blocks a booking. A seat needs a name, a mobile and an email;
it is the profile built afterwards that needs the rest.

Two edits the fallback deliberately does **not** absorb, because guessing would
be worse than reporting the gap: changing a question's option list (it is then a
different question, and its answers are not BISTrainer's vocabulary), and having
two questions with identical options (nothing says which one the answer belongs
to). Both surface as `notCollected`.

## Known limitation: the public-holiday list

The notice rule skips WA public holidays from a stored list that currently ends
**2026-12-28**. Past that date the rule silently treats a holiday as a working
day, which could allow a booking with too little real notice.

The API does not hide this: any date beyond the list is returned with
`holidayListExpired: true`, and candidates carry a `holiday_list_expired`
warning. Extend `CHC_PUBLIC_HOLIDAYS` in `packages/shared/src/chc-intake.ts`
when the next year's dates are published.
