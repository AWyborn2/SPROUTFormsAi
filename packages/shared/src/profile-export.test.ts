import { describe, expect, it } from 'vitest';
import { PROFILE_FIELDS, sensitiveProfileFieldKeys } from './profile.js';
import {
  buildProfileExport,
  exportedProfileFieldKeys,
  redactProfile,
  type ExportedDocument,
} from './profile-export.js';

const FIELDS: Record<string, string | null> = {
  firstName: 'Jane',
  lastName: 'Smith',
  dateOfBirth: '1990-04-17',
  addressStreet: '12 Mill Road',
  suburb: 'Boddington',
  postcode: '6390',
  ethnicity: 'Aboriginal',
  indigenousStatus: 'indigenous',
  mobile: '0400 000 000',
  emergencyContactName: 'Chris Smith',
  emergencyContactPhone: '0400 111 111',
  employeeNumber: 'E100',
};

const DOC: ExportedDocument = {
  id: 'doc-1',
  fileName: 'hr-licence.pdf',
  contentType: 'application/pdf',
  competencyName: 'HR Licence',
  storageKey: 'org-1/doc-1.pdf',
};

describe('redactProfile (R8)', () => {
  it('withholds the date of birth and the address', () => {
    const out = redactProfile(FIELDS);
    expect(out).not.toHaveProperty('dateOfBirth');
    expect(out).not.toHaveProperty('addressStreet');
    expect(out.firstName).toBe('Jane');
  });

  it('DROPS a withheld key rather than nulling it', () => {
    /*
      A null would read as "this record has no date of birth", which is a
      different and wrong fact from "we are not telling you". A consumer that
      cannot tell those apart would report a complete record as incomplete.
    */
    const out = redactProfile(FIELDS);
    expect('dateOfBirth' in out).toBe(false);
  });

  it('does NOT redact the emergency contact, departing from the induction pattern', () => {
    /*
      Deliberate. The induction pattern withholds both the name and the phone;
      here neither is marked sensitive, because a next-of-kin contact is exactly
      what an organisation needs to reach in the moment it matters, and an export
      that withheld it would be useless at the only time it counts.
    */
    const spec = PROFILE_FIELDS.find((f) => f.key === 'emergencyContactName')!;
    expect(spec.sensitive).toBe(false);

    const out = redactProfile(FIELDS);
    expect(out.emergencyContactName).toBe('Chris Smith');
    expect(out.emergencyContactPhone).toBe('0400 111 111');
  });

  it('is driven by the inventory, so every sensitive key is withheld and no other', () => {
    // The property that matters is not which fields are sensitive today — it is
    // that this function holds no second list to drift from the inventory.
    const out = redactProfile(FIELDS);
    const sensitive = new Set(sensitiveProfileFieldKeys());
    for (const key of Object.keys(FIELDS)) {
      expect(key in out).toBe(!sensitive.has(key));
    }
  });

  it('withholds the derived Indigenous status too, which is marked sensitive', () => {
    // Derived from the ethnicity answer, and no less sensitive for being derived
    // — redacting the ethnicity and leaking its derivation would withhold
    // nothing at all.
    expect(sensitiveProfileFieldKeys()).toContain('indigenousStatus');
    expect(redactProfile(FIELDS)).not.toHaveProperty('indigenousStatus');
  });
});

describe('buildProfileExport (R29, R54)', () => {
  const at = new Date('2026-08-06T02:00:00Z');

  it('carries every field unredacted by default, because R54 admits nobody else', () => {
    const out = buildProfileExport({ membershipId: 'm-1', fields: FIELDS, documents: [DOC], exportedAt: at });
    expect(out.fields).toEqual(FIELDS);
    expect(out.exportedAt).toBe('2026-08-06T02:00:00.000Z');
  });

  it('keeps the DOCUMENT FILES whatever the redaction did (R29)', () => {
    /*
      The point of an export is that the licence can be produced as evidence,
      and a redacted image is not evidence. So the exemption is unconditional
      rather than a flag the caller can get wrong.
    */
    const out = buildProfileExport({
      membershipId: 'm-1',
      fields: FIELDS,
      documents: [DOC],
      exportedAt: at,
      redact: true,
    });
    expect(out.fields).not.toHaveProperty('dateOfBirth');
    expect(out.documents).toEqual([DOC]);
    expect(out.documents[0]!.storageKey).toBe('org-1/doc-1.pdf');
  });

  it('copies its inputs, so a later mutation cannot reach a finished export', () => {
    const documents = [DOC];
    const out = buildProfileExport({ membershipId: 'm-1', fields: FIELDS, documents, exportedAt: at });
    documents.pop();
    expect(out.documents).toHaveLength(1);
  });
});

describe('exportedProfileFieldKeys', () => {
  it('derives from the inventory, so a field added to the record is exported', () => {
    const keys = exportedProfileFieldKeys();
    expect(keys).toContain('firstName');
    expect(keys).toContain('emergencyContactPhone');
    // The generated username is the account's, not the record's.
    expect(keys).not.toContain('username');
  });
});

describe('no matrix setting grants export on profiles (R54)', () => {
  it('grants `export` on the category to nobody, not even an Owner', async () => {
    /*
      `export` exists as an action — submissions and assessments both carry it —
      which is exactly why this is worth pinning. Adding it to `profiles` is the
      tempting implementation, and it would let an organisation grant the most
      sensitive act in the product to any access level it liked. The route gates
      on the ADMIN ACCESS LEVEL instead, so the matrix must never be able to
      answer the question at all.

      Asserted on the VALUE rather than the key: several roles are built from a
      deny-everything base that spreads `export: false`, and present-and-denied
      is the fail-closed shape. What must never happen is a true.
    */
    const { DEFAULT_ROLE_PERMISSIONS, ROLES, matrixAllows } = await import('./roles.js');
    for (const role of ROLES) {
      expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS[role], 'profiles', 'export')).toBe(false);
    }
  });
});
