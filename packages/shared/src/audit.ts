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
  | 'general';

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
  /** Lucide icon name for the row. */
  icon: string;
  createdAt: string;
}
