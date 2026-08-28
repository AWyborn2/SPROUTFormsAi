import { describe, expect, it } from 'vitest';
import type { FormField } from './form-field.js';
import { operatorNameFieldId } from './operator-prefill.js';

const field = (id: string, label: string, type: FormField['type'] = 'text'): FormField => ({
  id,
  type,
  label,
  required: false,
  source: 'imported',
});

describe('operatorNameFieldId', () => {
  it('finds the Operator field on a pre-start', () => {
    const fields = [
      field('f-date', 'Date'),
      field('f-asset', 'Asset No'),
      field('f-op', 'Operator'),
      field('f-hrs', 'HRS/KMS'),
    ];
    expect(operatorNameFieldId(fields)).toBe('f-op');
  });

  it('finds a Driver field too', () => {
    expect(operatorNameFieldId([field('f-drv', 'Driver Name')])).toBe('f-drv');
  });

  it('falls back to a "Your name" field when there is no operator/driver', () => {
    expect(operatorNameFieldId([field('f-name', 'Your name')])).toBe('f-name');
  });

  it('prefers a unique operator field over a your-name field', () => {
    const fields = [field('f-op', 'Operator'), field('f-name', 'Your name')];
    expect(operatorNameFieldId(fields)).toBe('f-op');
  });

  it('never seeds someone ELSE’s name box', () => {
    expect(operatorNameFieldId([field('f-sup', 'Supervisor name')])).toBeUndefined();
    expect(operatorNameFieldId([field('f-ass', 'Assessor Name')])).toBeUndefined();
    expect(operatorNameFieldId([field('f-wit', 'Witness')])).toBeUndefined();
  });

  it('never seeds a non-person name box (company/site/asset)', () => {
    expect(operatorNameFieldId([field('f-co', 'Company name')])).toBeUndefined();
    expect(operatorNameFieldId([field('f-site', 'Site name')])).toBeUndefined();
    expect(operatorNameFieldId([field('f-emp', 'Employee Number')])).toBeUndefined();
  });

  it('does not guess between two equally-plausible person fields', () => {
    const fields = [field('f-op', 'Operator'), field('f-drv', 'Driver')];
    expect(operatorNameFieldId(fields)).toBeUndefined();
  });

  it('only considers plain text fields — not a choice or signature', () => {
    expect(operatorNameFieldId([field('f-op', 'Operator', 'signature')])).toBeUndefined();
    expect(operatorNameFieldId([field('f-op', 'Operator', 'radio')])).toBeUndefined();
  });
});
