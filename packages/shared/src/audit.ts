/**
 * Audit log — who did what, when, on which entity. Written by the API on every
 * mutating action.
 */

export type AuditCategory =
  | 'forms'
  | 'submissions'
  | 'team'
  | 'settings'
  | 'security'
  | 'general'
  /*
    Member profile edits (R57). Its own category rather than `team` because R58
    reads it: an entry in this category covering a field the inventory marks
    sensitive is Admin-only, which narrows a Reviewer's existing audit read for
    those entries and nothing else.
  */
  | 'profiles';

export interface AuditLogEntry {
  id: string;
  orgId: string;
  /** Actor's user id, or null for system actions. */
  actorId: string | null;
  /** Denormalised actor name for display. */
  actorName: string;
  action: string;
  target: string;
  category: AuditCategory;
  /**
   * The profile inventory's key for the field this entry covers (R57), or null
   * on every entry that is not about one field. R58's filter compares it against
   * the inventory's sensitive marks.
   */
  field?: string | null;
  /** Lucide icon name for the row. */
  icon: string;
  createdAt: string;
}
