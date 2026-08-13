/**
 * Reading and writing the assessment builder's draft row.
 *
 * SEPARATE FROM `useBuilderDraftState` ON PURPOSE. That hook's contract is
 * state and pure reducers — the note on `setVersionIds` spells out why: a
 * network call inside it makes every consumer need a `QueryClientProvider` to
 * hold a field list, and a request every test has to mock. Putting react-query
 * in there proved the point immediately, turning three test files red. So the
 * state hook takes a snapshot in and hands a snapshot out, and everything with
 * a wire attached lives here.
 *
 * TWO HOOKS, NOT ONE, because the data flows in a line and hooks run in order:
 * the load has to happen BEFORE the state hook (it supplies what to hydrate
 * from) and the save has to happen AFTER it (it consumes what that produced).
 * One combined hook would have to be called in both places at once.
 *
 *     const resume = useBuilderResume(draftId)
 *     const draft  = useBuilderDraftState({ hydrateFrom: resume.hydrateFrom })
 *     const saved  = useBuilderAutosave(draft.snapshot, step, resume.ready)
 *
 * The row, its migration, the four routes and the "Pick up where you left off"
 * list were all already built. What was missing was anything that called them —
 * plus a path bug that made the list fetch `/builder-drafts` while the router
 * is mounted at `/assessment-tool-drafts`, so it was always empty.
 */
import { useEffect, useRef, useState } from 'react';
import { resolveBuilderStep, type BuilderStep } from '@formai/shared';
import { useBuilderDraft, useSaveBuilderDraft } from '../../../lib/data/hooks.js';
import {
  draftName,
  fromDraftState,
  isSaveable,
  toDraftState,
  type BuilderSnapshot,
} from './builder-draft-state.js';

/**
 * How long the builder waits after the last edit before writing.
 *
 * The state is an entire extraction plus every field and every key — megabytes
 * on a real paper, which is why the route's body limit is 40mb — so a write per
 * keystroke would saturate the connection. Long enough that a burst of typing
 * is one write; short enough that a tab closed mid-thought loses a sentence
 * rather than a session.
 */
export const AUTOSAVE_DELAY_MS = 2000;

export interface BuilderResume {
  /** The saved state to restore. Undefined until it has been read. */
  hydrateFrom?: BuilderSnapshot;
  /** The step the saved draft was parked on. */
  resumedStep?: BuilderStep;
  /** True only while a resume is genuinely outstanding. */
  resuming: boolean;
  /**
   * Whether it is safe to start writing.
   *
   * Saving while a resume is in flight would put the empty initial state over
   * the row being loaded — destroying the draft in the act of opening it. A
   * builder opened with no `draftId` has nothing to wait for and is ready
   * immediately; one whose draft 404s is ready too, because a draft that is
   * gone cannot be overwritten and the author should not be stuck.
   */
  ready: boolean;
}

/** Read the draft named in the route, if there is one. */
export function useBuilderResume(draftId: string | undefined): BuilderResume {
  const loaded = useBuilderDraft(draftId);

  /*
    PINNED, because `fromDraftState` builds a new object every render and the
    value is handed to a hydration effect. The state hook guards with a ref and
    applies it once, so churn is harmless there — but a stable identity means
    the effect does not re-run at all, which is a better guarantee than one
    that depends on the consumer's own care.
  */
  const pinned = useRef<BuilderSnapshot | undefined>(undefined);
  if (loaded.data && !pinned.current) pinned.current = fromDraftState(loaded.data.state);

  return {
    ...(pinned.current ? { hydrateFrom: pinned.current } : {}),
    ...(loaded.data ? { resumedStep: resolveBuilderStep(loaded.data.step) } : {}),
    resuming: Boolean(draftId) && loaded.isPending,
    ready: !draftId || loaded.isSuccess || loaded.isError,
  };
}

export interface BuilderAutosave {
  /** The row this session writes to, once one exists. */
  savedDraftId?: string;
  /** When the last write landed. */
  savedAt?: Date;
}

/**
 * Write the snapshot, debounced, once resuming has settled.
 *
 * @param snapshot the builder's live state
 * @param step where the author is, so a resume reopens there
 * @param ready `BuilderResume.ready` — never write before it is true
 * @param draftId the row from the route, if the session started with one
 */
export function useBuilderAutosave(
  snapshot: BuilderSnapshot,
  step: BuilderStep,
  ready: boolean,
  draftId?: string,
): BuilderAutosave {
  const save = useSaveBuilderDraft();
  const [savedDraftId, setSavedDraftId] = useState<string | undefined>(draftId);

  /*
    The step and the mutation are read at FIRE time rather than depended on.
    `step` changes as the author navigates, and depending on it would schedule
    a write for a walk through the stepper that changed nothing; whatever step
    they are on when a real edit lands is the one recorded.
  */
  const latest = useRef({ step, save });
  latest.current = { step, save };

  useEffect(() => {
    if (!ready || !isSaveable(snapshot)) return;

    const timer = setTimeout(() => {
      const { step: at, save: mutation } = latest.current;
      void mutation
        .mutateAsync({
          name: draftName(snapshot),
          assetId: snapshot.assetId!,
          step: at,
          state: toDraftState(snapshot) as Record<string, unknown>,
          formId: snapshot.formId ?? null,
          versionId: snapshot.versionId ?? null,
          // The COLUMN, not just state: the server enforces one revision
          // draft per tool through it.
          revisionOfToolId: snapshot.revisionOfToolId ?? null,
        })
        .then((row) => {
          // The id is what makes THIS tab resumable: the screen puts it in the
          // URL, so a refresh from here reopens the draft rather than a blank
          // builder.
          setSavedDraftId((prev) => prev ?? row.id);
        })
        .catch(() => {
          /*
            Swallowed deliberately. A failed autosave must not interrupt
            authoring with an error the author cannot act on, and the next edit
            retries. The "Saved HH:MM" stamp not moving is the honest signal —
            which is why the screen shows it.
          */
        });
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [snapshot, ready]);

  return {
    ...(savedDraftId ? { savedDraftId } : {}),
    ...(save.data ? { savedAt: new Date(save.data.updatedAt) } : {}),
  };
}
