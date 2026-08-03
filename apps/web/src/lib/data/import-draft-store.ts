/**
 * Where a half-finished import is kept between visits.
 *
 * Mapping an eighteen-page assessment is hours of work — every field corrected,
 * every option box placed and confirmed against the printed page — and until
 * now all of it lived in module-level variables. A refresh, a crash, or one
 * stray navigation and the lot was gone with nothing to recover from.
 *
 * TWO STORES, DELIBERATELY DIFFERENT THINGS. This one is the local autosave:
 * continuous, unnamed, one per uploaded document, and its job is that an
 * INTERRUPTION costs nothing. Saving a named draft to the server is a separate
 * act with a separate meaning — a deliberate handover, or work you intend to
 * resume on another machine — and it does not belong behind the same mechanism.
 *
 * IndexedDB rather than localStorage: an extraction plus a hundred and sixty
 * placement boxes runs to megabytes, which is at or past what localStorage will
 * hold, and localStorage writes synchronously on the main thread — this store
 * is written on every edit.
 */
import type { DocumentType, ExtractionResult, FormField, PageBox } from '@formai/shared';
import type { GroupOrdinal } from '@formai/shared';

/**
 * Bumped whenever the shape below changes incompatibly. A snapshot from an
 * older version is DISCARDED rather than migrated: it is an autosave, the
 * document it describes is still on the server, and re-extracting costs a
 * minute — where guessing at a half-understood older shape could silently
 * restore geometry onto the wrong fields.
 */
export const IMPORT_SNAPSHOT_VERSION = 1;

/** The extraction-run metadata a review row carries that a FormField does not. */
export interface ReviewMetaEntry {
  note?: string;
  resolved?: boolean;
  columnGroups?: number;
  groupOrdinal?: GroupOrdinal;
  questionRef?: string;
}

/** One placement, flattened out of the two stores that hold it. */
export interface SnapshotPlacement {
  /** Field id, or the composite option slot from `optionSlotId`. */
  slot: string;
  box: PageBox;
  confirmed: boolean;
}

/**
 * Everything needed to put a reviewer back where they were.
 *
 * NOT the PDF bytes. The document is already on the server under `assetId` and
 * the viewer falls back to fetching it, so carrying a base64 copy would multiply
 * the size of every write for something already stored. The one thing lost with
 * it is retry-the-extraction, which needs the original bytes in hand — after a
 * restore that means re-uploading, which is the honest answer anyway since a
 * retry is about a failed run and a restored session is a successful one.
 *
 * NOT the undo history either. You cannot undo across a page load in any tool
 * that has ever existed, and pretending otherwise would mean restoring a stack
 * of states the reviewer has no memory of building.
 */
export interface ImportSnapshot {
  version: number;
  /** ISO instant, shown when offering to restore so it is clear what is on offer. */
  savedAt: string;
  fileName: string;
  pageCount: number;
  designNotes: string[];
  assetId: string | null;
  extraction: ExtractionResult | null;
  targetFormId: string | null;
  documentType: DocumentType;
  fields: FormField[];
  reviewMeta: [string, ReviewMetaEntry][];
  acceptedAnswerSets: string[];
  placements: SnapshotPlacement[];
}

/**
 * The storage behind the autosave. An interface rather than direct IndexedDB
 * calls because jsdom has no IndexedDB, so the capture/restore logic — which is
 * the part that can actually be wrong — would otherwise be untestable without
 * a polyfill.
 */
export interface ImportDraftStore {
  load(key: string): Promise<ImportSnapshot | null>;
  save(key: string, snapshot: ImportSnapshot): Promise<void>;
  clear(key: string): Promise<void>;
  /**
   * The most recently saved snapshot, whatever its key.
   *
   * Needed because of how the work is lost in the first place: after a refresh
   * the session is empty, so nothing knows which asset id to ask for. Keying by
   * asset is still right — it is what keeps two documents apart — but the entry
   * point has to be able to find the work without already knowing it.
   */
  latest(): Promise<ImportSnapshot | null>;
}

const DB_NAME = 'formai-import';
const DB_VERSION = 1;
const STORE = 'drafts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb_open_failed'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexeddb_request_failed'));
      }),
  );
}

/**
 * A store that never throws at the caller.
 *
 * Autosave is a safety net, and a safety net that can itself break the thing it
 * protects is worse than none — a private-mode browser, a full disk or a denied
 * storage permission must not take the wizard down mid-review. Every failure
 * resolves to "nothing saved" and is logged, which is exactly how a reviewer
 * would experience it before this existed.
 */
export function indexedDbDraftStore(): ImportDraftStore {
  const unavailable = typeof indexedDB === 'undefined';

  return {
    async load(key) {
      if (unavailable) return null;
      try {
        return (await tx<ImportSnapshot | undefined>('readonly', (s) => s.get(key))) ?? null;
      } catch (err) {
        console.warn('import autosave: could not read', err);
        return null;
      }
    },
    async save(key, snapshot) {
      if (unavailable) return;
      try {
        await tx('readwrite', (s) => s.put(snapshot, key));
      } catch (err) {
        console.warn('import autosave: could not write', err);
      }
    },
    async clear(key) {
      if (unavailable) return;
      try {
        await tx('readwrite', (s) => s.delete(key));
      } catch (err) {
        console.warn('import autosave: could not clear', err);
      }
    },
    async latest() {
      if (unavailable) return null;
      try {
        const all = await tx<ImportSnapshot[]>('readonly', (s) => s.getAll());
        return newestOf(all);
      } catch (err) {
        console.warn('import autosave: could not list', err);
        return null;
      }
    },
  };
}

/** The most recently saved of a set, or null. Compared on the stored instant. */
function newestOf(snapshots: readonly ImportSnapshot[]): ImportSnapshot | null {
  let newest: ImportSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (!newest || snapshot.savedAt > newest.savedAt) newest = snapshot;
  }
  return newest;
}

/** An in-memory stand-in — the default under test, and when storage is refused. */
export function memoryDraftStore(): ImportDraftStore {
  const held = new Map<string, ImportSnapshot>();
  return {
    async load(key) {
      return held.get(key) ?? null;
    },
    async save(key, snapshot) {
      held.set(key, snapshot);
    },
    async clear(key) {
      held.delete(key);
    },
    async latest() {
      return newestOf([...held.values()]);
    },
  };
}

/**
 * A snapshot is stored per DOCUMENT, not per session.
 *
 * The asset id is the identity of the thing being mapped, so re-entering the
 * wizard with the same upload finds the same work, and starting a different
 * document cannot collide with it. A session with no asset has nothing worth
 * saving — the extraction has not run.
 */
export function draftKey(assetId: string | null): string | null {
  return assetId ? `asset:${assetId}` : null;
}

/**
 * True when a snapshot is worth offering back.
 *
 * Version-mismatched snapshots are dropped rather than migrated (see above), and
 * one with no fields is an extraction that never landed — restoring it would put
 * the reviewer in front of an empty list and call it recovered work.
 */
export function isRestorable(snapshot: ImportSnapshot | null): snapshot is ImportSnapshot {
  return (
    snapshot !== null &&
    snapshot.version === IMPORT_SNAPSHOT_VERSION &&
    Array.isArray(snapshot.fields) &&
    snapshot.fields.length > 0
  );
}
