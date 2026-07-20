/**
 * Form templates and their immutable versions.
 *
 * Publishing freezes a version; editing a published version forks a new draft.
 * Submissions pin the exact `versionId` they were filled against.
 */

import type { FormContainer, FormField } from './form-field.js';

export type FormSourceType = 'pdf_import' | 'built_from_scratch';
export type TemplateStatus = 'draft' | 'published' | 'archived';
export type VersionState = 'draft' | 'published';

export interface FormTemplate {
  id: string;
  orgId: string;
  name: string;
  dept?: string;
  sourceType: FormSourceType;
  status: TemplateStatus;
  /** Points at the version currently shown as "the" template. */
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FormTemplateVersion {
  id: string;
  templateId: string;
  /** e.g. "v1", "v2". */
  versionLabel: string;
  state: VersionState;
  /** The frozen field set. Immutable once state === 'published'. */
  fields: FormField[];
  container: FormContainer;
  /** For pdf_import templates — the stored original PDF asset. */
  sourcePdfAssetId: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
}
