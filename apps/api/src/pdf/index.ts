/** PDF pipeline — extraction (two paths) + round-trip export. */
export {
  extractForm,
  parseExtractionResponse,
  parseJsonFence,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_PAGE_BATCH_SIZE,
  type AnthropicLike,
  type AnthropicMessage,
  type ExtractOptions,
} from './extract.js';
export {
  roundTripExport,
  resolveMarkStyle,
  type DrawnGlyph,
  type RoundTripInput,
} from './round-trip.js';
export {
  assembleCaseValues,
  exportCasePdf,
  withDerivedMarks,
  CaseExportError,
  type AssembledCase,
  type AssembleCaseInput,
  type CaseAttemptRecord,
  type ExportCaseInput,
} from './case-export.js';
export { auditForm, parseAuditResponse, AUDIT_MAX_TOKENS, type AuditOptions } from './audit.js';
export {
  extractFormFieldsTool,
  EXTRACT_TOOL_NAME,
  reportMissedFieldsTool,
  AUDIT_TOOL_NAME,
} from './tool-schema.js';
export {
  matchAnswerGuide,
  resolveOption,
  matchGuideAnswersTool,
  MATCH_TOOL_NAME,
  type GuideQuestion,
  type GuideMatchResult,
} from './answer-guide.js';
