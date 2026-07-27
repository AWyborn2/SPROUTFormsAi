/**
 * Spoken-phrase -> typed answer. The refusal cases matter as much as the
 * successes: anything this file lets through lands in a submission unreviewed.
 */
import { describe, expect, it } from 'vitest';
import { FORM_FIELD_TYPES, type FormField, type FormFieldType } from '@formai/shared';
import { coerceSpokenValue, isDictatable } from './coerce.js';

function field(type: FormFieldType, extra: Partial<FormField> = {}): FormField {
  return { id: `f-${type}`, type, label: type, required: false, source: 'built', ...extra };
}

/** Fixed anchor so relative dates never depend on when the suite runs. */
const NOW = new Date(2026, 6, 27); // Monday 27 July 2026

describe('isDictatable', () => {
  it('offers a mic for every type that can be answered by speaking', () => {
    expect(FORM_FIELD_TYPES.filter(isDictatable)).toEqual([
      'text',
      'number',
      'date',
      'checkbox',
      'radio',
      'dropdown',
      'checkbox_group',
      'boolean_yes_no',
      'check_cross',
      'textarea',
    ]);
  });

  it('withholds it from types that need a physical act, take no answer, or need a format speech cannot pin down', () => {
    expect(FORM_FIELD_TYPES.filter((t) => !isDictatable(t))).toEqual([
      'time',
      'signature',
      'file_upload',
      'section_header',
      'repeating_group',
    ]);
  });
});

describe('coerceSpokenValue — text and textarea', () => {
  it('keeps the phrase verbatim apart from surrounding whitespace', () => {
    expect(coerceSpokenValue(field('text'), '  Priya Nand  ')).toBe('Priya Nand');
    expect(coerceSpokenValue(field('textarea'), 'guard was missing, tagged out')).toBe(
      'guard was missing, tagged out',
    );
  });

  it('refuses a phrase that is only whitespace', () => {
    expect(coerceSpokenValue(field('text'), '   ')).toBeNull();
    expect(coerceSpokenValue(field('textarea'), '')).toBeNull();
  });
});

describe('coerceSpokenValue — number', () => {
  it('reads digits out of a phrase', () => {
    expect(coerceSpokenValue(field('number'), '42')).toBe(42);
    expect(coerceSpokenValue(field('number'), 'about 7 units')).toBe(7);
  });

  it('strips currency symbols, unit words and thousands separators', () => {
    expect(coerceSpokenValue(field('number'), '$1,500')).toBe(1500);
    expect(coerceSpokenValue(field('number'), '25 dollars')).toBe(25);
    expect(coerceSpokenValue(field('number'), 'twenty five kilograms')).toBe(25);
    expect(coerceSpokenValue(field('number'), 'twelve metres')).toBe(12);
  });

  it('keeps a decimal fraction', () => {
    expect(coerceSpokenValue(field('number'), '3.5 hours')).toBe(3.5);
  });

  /**
   * The recogniser has no inverse text normalisation, so this — not "3.5" — is
   * how every dictated decimal actually arrives. Truncating it to 3 wrote a
   * confidently wrong depth or hours-worked onto a compliance record.
   */
  it('reads a spoken decimal rather than truncating it to the whole part', () => {
    expect(coerceSpokenValue(field('number'), 'three point five')).toBe(3.5);
    expect(coerceSpokenValue(field('number'), 'one point two five')).toBe(1.25);
    expect(coerceSpokenValue(field('number'), 'twelve point seven five')).toBe(12.75);
    expect(coerceSpokenValue(field('number'), 'zero point five')).toBe(0.5);
    expect(coerceSpokenValue(field('number'), 'three point five hours')).toBe(3.5);
    expect(coerceSpokenValue(field('number'), 'minus one point five')).toBe(-1.5);
  });

  it('reads a bare fraction as a fraction, not as its digits', () => {
    expect(coerceSpokenValue(field('number'), 'point five')).toBe(0.5);
  });

  it('refuses a fraction it cannot read one digit at a time', () => {
    expect(coerceSpokenValue(field('number'), 'one point fifteen')).toBeNull();
    expect(coerceSpokenValue(field('number'), 'nought point eight')).toBeNull();
    expect(coerceSpokenValue(field('number'), 'three point')).toBeNull();
  });

  /**
   * Two spoken numbers in a row are two numbers. Adding them turned a year into
   * arithmetic nobody said — and a refusal shows the respondent the phrase back
   * so they can type it, where 109 just looks like an answer they gave.
   */
  it('refuses two numbers running together instead of adding them', () => {
    expect(coerceSpokenValue(field('number'), 'nineteen ninety')).toBeNull();
    expect(coerceSpokenValue(field('number'), 'nineteen ninety nine')).toBeNull();
    expect(coerceSpokenValue(field('number'), 'twenty twenty five')).toBeNull();
  });

  it('parses spelled-out numbers from zero to twenty', () => {
    const spoken = [
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
      'nineteen', 'twenty',
    ];
    expect(spoken.map((s) => coerceSpokenValue(field('number'), s))).toEqual(
      spoken.map((_, i) => i),
    );
  });

  it('parses compound tens and larger magnitudes', () => {
    expect(coerceSpokenValue(field('number'), 'twenty five')).toBe(25);
    expect(coerceSpokenValue(field('number'), 'forty seven')).toBe(47);
    expect(coerceSpokenValue(field('number'), 'ninety nine')).toBe(99);
    expect(coerceSpokenValue(field('number'), 'one hundred and five')).toBe(105);
    expect(coerceSpokenValue(field('number'), 'two thousand five hundred')).toBe(2500);
  });

  it('handles a spoken or written negative', () => {
    expect(coerceSpokenValue(field('number'), 'minus five')).toBe(-5);
    expect(coerceSpokenValue(field('number'), 'negative twelve')).toBe(-12);
    expect(coerceSpokenValue(field('number'), '-8')).toBe(-8);
  });

  it('refuses a phrase with no number in it', () => {
    expect(coerceSpokenValue(field('number'), 'quite a few')).toBeNull();
    expect(coerceSpokenValue(field('number'), 'not sure')).toBeNull();
    expect(coerceSpokenValue(field('number'), 'yes')).toBeNull();
  });
});

describe('coerceSpokenValue — date', () => {
  const date = field('date');

  it('resolves relative days against the injected now', () => {
    expect(coerceSpokenValue(date, 'today', NOW)).toBe('2026-07-27');
    expect(coerceSpokenValue(date, 'yesterday', NOW)).toBe('2026-07-26');
    expect(coerceSpokenValue(date, 'tomorrow', NOW)).toBe('2026-07-28');
    expect(coerceSpokenValue(date, 'I did it yesterday', NOW)).toBe('2026-07-26');
  });

  it('crosses month and year boundaries when shifting', () => {
    expect(coerceSpokenValue(date, 'tomorrow', new Date(2026, 11, 31))).toBe('2027-01-01');
    expect(coerceSpokenValue(date, 'yesterday', new Date(2026, 0, 1))).toBe('2025-12-31');
  });

  it('parses a month with an ordinal or cardinal day', () => {
    expect(coerceSpokenValue(date, 'march fifth twenty twenty five', NOW)).toBe('2025-03-05');
    expect(coerceSpokenValue(date, 'the third of april twenty twenty six', NOW)).toBe('2026-04-03');
    expect(coerceSpokenValue(date, '5 march 2025', NOW)).toBe('2025-03-05');
    expect(coerceSpokenValue(date, 'sept 9 2026', NOW)).toBe('2026-09-09');
  });

  it('reads a compound ordinal day without mistaking it for a year', () => {
    expect(coerceSpokenValue(date, 'march twenty fifth twenty twenty six', NOW)).toBe('2026-03-25');
    expect(coerceSpokenValue(date, 'january thirty first', NOW)).toBe('2026-01-31');
    expect(coerceSpokenValue(date, 'march twenty five', NOW)).toBe('2026-03-25');
  });

  it('understands the spoken year forms', () => {
    expect(coerceSpokenValue(date, 'june first two thousand and five', NOW)).toBe('2005-06-01');
    expect(coerceSpokenValue(date, 'june first nineteen ninety nine', NOW)).toBe('1999-06-01');
    expect(coerceSpokenValue(date, 'june first twenty fifteen', NOW)).toBe('2015-06-01');
  });

  it('falls back to the current year when none was spoken', () => {
    expect(coerceSpokenValue(date, 'the fifth of march', NOW)).toBe('2026-03-05');
    expect(coerceSpokenValue(date, 'the fifth of march', new Date(2031, 0, 2))).toBe('2031-03-05');
  });

  it('passes an already-ISO value straight through', () => {
    expect(coerceSpokenValue(date, '2028-02-29', NOW)).toBe('2028-02-29');
    expect(coerceSpokenValue(date, '2026-02-29', NOW)).toBeNull();
    expect(coerceSpokenValue(date, '2026-13-01', NOW)).toBeNull();
  });

  it('refuses a day the month does not have', () => {
    expect(coerceSpokenValue(date, 'february thirtieth twenty twenty six', NOW)).toBeNull();
    expect(coerceSpokenValue(date, 'april thirty first', NOW)).toBeNull();
  });

  it('refuses a phrase with no month and no relative word', () => {
    expect(coerceSpokenValue(date, 'sometime next week', NOW)).toBeNull();
    expect(coerceSpokenValue(date, 'the fifteenth', NOW)).toBeNull();
    expect(coerceSpokenValue(date, 'march', NOW)).toBeNull();
  });
});

describe('coerceSpokenValue — booleans', () => {
  for (const type of ['boolean_yes_no', 'check_cross', 'checkbox'] as const) {
    describe(type, () => {
      const f = field(type);

      it('maps the affirmative vocabulary to true', () => {
        for (const word of ['yes', 'yeah', 'Yep', 'correct', 'affirmative', 'true', 'pass', 'ok', 'tick']) {
          expect(coerceSpokenValue(f, word)).toBe(true);
        }
      });

      it('maps the negative vocabulary to false', () => {
        for (const word of ['no', 'nope', 'negative', 'false', 'fail', 'cross']) {
          expect(coerceSpokenValue(f, word)).toBe(false);
        }
      });

      it('takes the first decisive word so a qualified answer still lands', () => {
        expect(coerceSpokenValue(f, 'no, the guard was missing')).toBe(false);
        expect(coerceSpokenValue(f, 'yes it passed the check')).toBe(true);
      });

      it('refuses a phrase carrying neither vocabulary', () => {
        expect(coerceSpokenValue(f, 'maybe')).toBeNull();
        expect(coerceSpokenValue(f, 'the compressor')).toBeNull();
      });

      it('is not fooled by a word that merely contains one', () => {
        expect(coerceSpokenValue(f, 'nozzle')).toBeNull();
        expect(coerceSpokenValue(f, 'crossbeam')).toBeNull();
      });
    });
  }
});

describe('coerceSpokenValue — radio and dropdown', () => {
  const options = ['Pass', 'Pass with defects', 'Fail'];
  const radio = field('radio', { options });
  const dropdown = field('dropdown', { options });

  it('returns the option string exactly as authored', () => {
    expect(coerceSpokenValue(radio, 'pass with defects')).toBe('Pass with defects');
    expect(coerceSpokenValue(dropdown, 'FAIL')).toBe('Fail');
  });

  it('ignores case and punctuation differences between speech and label', () => {
    const punctuated = field('dropdown', { options: ['Yes — with conditions', 'No/never'] });
    expect(coerceSpokenValue(punctuated, 'yes with conditions')).toBe('Yes — with conditions');
    expect(coerceSpokenValue(punctuated, 'no never')).toBe('No/never');
  });

  it('prefers the most specific option contained in the phrase', () => {
    expect(coerceSpokenValue(radio, 'it was a pass with defects overall')).toBe('Pass with defects');
  });

  it('accepts a shortened spoken form of a longer label', () => {
    const roles = field('dropdown', { options: ['Site supervisor', 'Plant operator'] });
    expect(coerceSpokenValue(roles, 'supervisor')).toBe('Site supervisor');
  });

  it('refuses a near miss rather than picking the closest label', () => {
    const levels = field('radio', { options: ['Level One', 'Level Two'] });
    expect(coerceSpokenValue(levels, 'level three')).toBeNull();
    expect(coerceSpokenValue(radio, 'electric')).toBeNull();
  });

  it('refuses when two options are equally good', () => {
    const sites = field('radio', { options: ['Site supervisor', 'Site manager'] });
    expect(coerceSpokenValue(sites, 'site')).toBeNull();
  });

  /**
   * The longest-contained rule is for NESTED labels ("pass" inside "pass with
   * defects"). Two unrelated options both spoken is an ambiguity, and letting
   * label length settle it made the answer depend on how the form author spelt
   * the option rather than on anything the respondent said.
   */
  it('refuses when two unrelated options both appear in the phrase', () => {
    const severity = field('dropdown', { options: ['Low', 'Medium', 'High'] });
    expect(coerceSpokenValue(severity, 'medium to high')).toBeNull();
    expect(coerceSpokenValue(severity, 'somewhere between low and medium')).toBeNull();

    const yesNo = field('dropdown', { options: ['Yes', 'No'] });
    expect(coerceSpokenValue(yesNo, 'no, not yes')).toBeNull();

    const shifts = field('radio', { options: ['Day shift', 'Night'] });
    expect(coerceSpokenValue(shifts, 'day shift then night')).toBeNull();
  });

  it('refuses when the field has no options at all', () => {
    expect(coerceSpokenValue(field('radio'), 'pass')).toBeNull();
  });
});

describe('coerceSpokenValue — checkbox_group', () => {
  const ppe = ['Hard hat', 'Gloves', 'Hi-vis vest'];

  it('splits a spoken list on commas and "and"', () => {
    expect(coerceSpokenValue(field('checkbox_group', { options: ppe }), 'hard hat and gloves')).toEqual([
      'Hard hat',
      'Gloves',
    ]);
    expect(
      coerceSpokenValue(field('checkbox_group', { options: ppe }), 'gloves, hi vis vest and hard hat'),
    ).toEqual(['Gloves', 'Hi-vis vest', 'Hard hat']);
  });

  it('does not shred an option whose own label contains "and"', () => {
    const f = field('checkbox_group', { options: ['Health and Safety', 'Environment'] });
    expect(coerceSpokenValue(f, 'Health and Safety')).toEqual(['Health and Safety']);
  });

  it('drops parts that match nothing instead of failing the whole phrase', () => {
    const f = field('checkbox_group', { options: ppe });
    expect(coerceSpokenValue(f, 'gloves and a thermos')).toEqual(['Gloves']);
  });

  it('never repeats an option said twice', () => {
    const f = field('checkbox_group', { options: ppe });
    expect(coerceSpokenValue(f, 'gloves and gloves')).toEqual(['Gloves']);
  });

  it('returns at most one option for a single-selection group', () => {
    const f = field('checkbox_group', { options: ppe, selectionType: 'single' });
    expect(coerceSpokenValue(f, 'hard hat and gloves')).toEqual(['Hard hat']);
  });

  it('refuses when nothing matched', () => {
    expect(coerceSpokenValue(field('checkbox_group', { options: ppe }), 'a thermos')).toBeNull();
    expect(coerceSpokenValue(field('checkbox_group'), 'gloves')).toBeNull();
  });
});

describe('coerceSpokenValue — undictatable types', () => {
  it('refuses regardless of what was said', () => {
    for (const type of ['signature', 'file_upload', 'section_header', 'repeating_group'] as const) {
      expect(coerceSpokenValue(field(type), 'yes March fifth 42')).toBeNull();
    }
  });

  // `time` is `HH:MM` only. Anything looser reaches the native time input as an
  // unrenderable value, so a spoken time must be refused rather than approximated.
  it('refuses a spoken time rather than approximating HH:MM', () => {
    for (const said of ['half nine', 'quarter to five', '9:30am', 'nine thirty', '0930']) {
      expect(coerceSpokenValue(field('time'), said)).toBeNull();
    }
  });

  it('offers no mic for time', () => {
    expect(isDictatable('time')).toBe(false);
  });
});
