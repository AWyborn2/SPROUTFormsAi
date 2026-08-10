---
title: A rejected document stays on the record in its own state, and is never deleted
date: 2026-08-06
category: decisions
module: competency-documents
problem_type: design_decision
component: service_object
symptoms:
  - "Rejecting a replacement could plausibly discard it, hide it, or overwrite the held one"
  - "Rejecting a HELD document and rejecting a REPLACEMENT are different acts on the same route"
  - "A candidate who supplied a bad copy needs to know it was refused and why"
root_cause: design_decision
resolution_type: design_choice
severity: medium
related_components: [competency-documents, document-notices, member-profiles]
tags: [document-state, rejection, retention, replacement, u32, u33]
---

# A rejected document stays on the record in its own state, and is never deleted

## The decision

`POST /competency-documents/:id/reject` writes a **state**, never a delete. Where
the document was a candidate-supplied replacement it moves to `rejected`; where
it was the record's held evidence it **keeps `state: 'held'`** and gains the
rejection stamp beside it. Both keep the file, the uploader, the timestamps and
the reason. A notice goes to whoever supplied it.

```ts
const wasReplacement = row.state === 'pending';
await db.update(schema.competencyDocuments).set({
  state: wasReplacement ? 'rejected' : row.state,
  rejectedByUserId: tenant.userId,
  rejectedAt: new Date(),
  rejectedReason: parsed.data.reason,
  approvedByUserId: null,
  approvedAt: null,
});
```

## The three candidates, and why the other two lose

**Delete it.** Loses the record of what the candidate submitted and when, which
is exactly what an argument about a refused licence turns on. Nothing in this
subsystem deletes: `documentStateEnum` has five values and not one of them is a
tombstone, because every state has to stay retrievable.

**Overwrite the held document.** Wrong for a replacement, and the reason is the
whole point of R52: a replacement is NOT the record's evidence until it is
accepted. Letting a rejected one displace what is already held would mean a
candidate could degrade their own record by supplying something worse.

**Hide it from the record.** Same failure as deleting, dressed up — a document
nobody can retrieve is one that does not exist, whatever the row says.

## Why rejecting a HELD document does not change its state

This is the part that reads like a bug and is not.

Rejecting a held document is a judgement about EVIDENCE the record already
stands on. The document is still what certified the person; what has changed is
that an approver has recorded an objection to it. Moving it out of `held` would
silently withdraw the competency it evidences — a consequence nobody asked for
on a route that only records an opinion.

Withdrawing a competency is `revoke`, and it is a different act with a different
audit trail. Conflating the two would mean an approver querying a certificate
accidentally marked somebody not competent.

The escape hatch for a document filed against the WRONG PERSON is `remove`,
which is Admin-only, reasoned and audited (R32) — and is still not a delete.

## The notice is not a courtesy

`noticeReplacementOutcome` writes a `document_notices` row for BOTH outcomes,
because R52 makes telling the candidate fixed rather than optional. The rejection
is the one they most need: it is the one that leaves them something to do.

It is **fail-soft** — a notice that cannot be written must not roll back a
decision an approver has already made — matching the posture the expiry sender
already takes.

## What a future reader needs to know

- **`approvedAt`/`approvedBy` are cleared on rejection**, so a document cannot
  read as both approved and rejected. The two stamps are mutually exclusive by
  construction rather than by convention.
- **The replacement rate limit counts SUBMISSIONS, not outcomes**
  (`REPLACEMENT_MAX_PER_WINDOW`, ten per hour, in memory per membership). A
  rejection does not give the attempt back, which is deliberate: a limiter that
  refunded refused attempts would let a candidate retry indefinitely by
  supplying documents bad enough to be refused.
- **The queue reads `state === 'pending' || (state === 'held' && rejectedAt !== null)`**,
  which is what surfaces a held-but-objected-to document for an Admin to resolve.
  That predicate is the reason the held state is preserved rather than moved: a
  state change would take the row off the very queue that exists to chase it.

## Related

- `packages/db/src/schema/enums.ts` — `documentStateEnum`, which documents each
  state's meaning and states plainly that nothing in it is a delete.
