/**
 * Create a competency INLINE and keep it locally pickable before the register
 * cache refetches — `useCreateCompetency`'s invalidation refetches in the
 * background, and a picker that cannot see the competency it just created
 * would strand its user mid-flow. Shared by every surface that creates from
 * inside another flow: the Role requirements editor, the backfill worklist
 * row (AE3), and the builder's award control (AE2).
 *
 * A SIBLING of hooks.ts rather than a resident: the screen tests mock the
 * hooks module wholesale, and living here keeps this composition real under
 * those mocks — it drives whichever `useCreateCompetency` the module system
 * hands it.
 */
import { useState } from 'react';
import { useCreateCompetency } from './hooks.js';
import type { Competency } from './types.js';

/**
 * No validity asked anywhere this is used: every competency starts perpetual,
 * and the register's validity editor is where expiry gets decided — these
 * flows' job is naming the link, not the whole record.
 *
 * Toasts and follow-up (what gets picked, forms closing) stay with the caller
 * via `onCreated`/`onError` — the sites agree on the mechanics, not the copy.
 */
export function useInlineCompetencyCreate(existing: Competency[]): {
  /** The register plus anything created here that the cache has not caught up with. */
  options: Competency[];
  create: (
    name: string,
    code: string | null,
    onCreated: (added: Competency) => void,
    onError: () => void,
  ) => void;
  isPending: boolean;
} {
  const mutation = useCreateCompetency();
  const [createdLocal, setCreatedLocal] = useState<Competency[]>([]);
  const options = [
    ...existing,
    ...createdLocal.filter((c) => !existing.some((r) => r.id === c.id)),
  ];
  function create(
    name: string,
    code: string | null,
    onCreated: (added: Competency) => void,
    onError: () => void,
  ) {
    mutation.mutate(
      { name, code, validForMonths: null, gracePeriodDays: null },
      {
        onSuccess: (added) => {
          setCreatedLocal((prev) => [...prev, added]);
          onCreated(added);
        },
        onError,
      },
    );
  }
  return { options, create, isPending: mutation.isPending };
}
