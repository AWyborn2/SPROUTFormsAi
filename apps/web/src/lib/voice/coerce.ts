/**
 * Turns one spoken phrase into a correctly-typed answer for one field.
 *
 * Pure and React-free so every branch can be exercised directly — this module
 * is where dictation correctness lives, and components only render what it
 * decides. Every path refuses (`null`) rather than guessing: an unfilled field
 * is a visible gap the respondent closes by hand, while a confidently wrong
 * answer on a compliance form gets signed off as though a human chose it.
 */
import type { FormField, FormFieldType, SubmissionValue } from '@formai/shared';

/**
 * Types a mic button is offered for. Signature and file upload need a physical
 * act, a section header takes no answer, and a repeating group is a table whose
 * per-cell dictation would need its own row/column addressing — none of them
 * degrade to "say the answer".
 */
const DICTATABLE_TYPES: ReadonlySet<FormFieldType> = new Set<FormFieldType>([
  'text',
  'textarea',
  'number',
  'date',
  'checkbox',
  'radio',
  'dropdown',
  'checkbox_group',
  'boolean_yes_no',
  'check_cross',
]);

/** Whether the fill UI should offer a mic for this field type. */
export function isDictatable(type: FormFieldType): boolean {
  return DICTATABLE_TYPES.has(type);
}

/**
 * Interpret `spoken` as an answer for `field`, or `null` when it cannot be read
 * confidently.
 *
 * `now` is injected rather than read from the clock so relative dates
 * ("yesterday") are testable and so a caller can anchor a whole form to one
 * instant instead of drifting across a midnight boundary mid-fill.
 */
export function coerceSpokenValue(
  field: FormField,
  spoken: string,
  now: Date = new Date(),
): SubmissionValue | null {
  const trimmed = spoken.trim();
  if (trimmed === '') return null;

  switch (field.type) {
    case 'text':
    case 'textarea':
      return trimmed;
    case 'number':
      return coerceNumber(trimmed);
    case 'date':
      return coerceDate(trimmed, now);
    case 'checkbox':
    case 'boolean_yes_no':
    case 'check_cross':
      return coerceBoolean(trimmed);
    case 'radio':
    case 'dropdown':
      return matchOption(field.options ?? [], trimmed);
    case 'checkbox_group':
      return coerceCheckboxGroup(field, trimmed);
    case 'signature':
    case 'file_upload':
    case 'section_header':
    case 'repeating_group':
      return null;
    // `time` stores a strict `HH:MM` 24-hour string. Reading one out of speech
    // ("half nine", "quarter to five", am/pm) is its own parser with its own
    // ambiguities, and a timesheet that silently records the wrong hour is
    // worse than one the respondent types. Refused until that parser exists —
    // it is absent from DICTATABLE_TYPES too, so no mic is offered either.
    case 'time':
      return null;
  }
}

/* ---------- normalisation ---------- */

/** Lowercase, punctuation collapsed to single spaces — the comparison form used throughout. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized === '' ? [] : normalized.split(' ');
}

/* ---------- yes / no ---------- */

const AFFIRMATIVE = new Set([
  'yes', 'yeah', 'yep', 'yup', 'correct', 'affirmative', 'true', 'pass', 'passed', 'ok', 'okay',
  'tick', 'ticked',
]);
const NEGATIVE = new Set([
  'no', 'nope', 'nah', 'negative', 'false', 'fail', 'failed', 'cross', 'incorrect',
]);

/**
 * First decisive word wins. People lead with the answer and then qualify it
 * ("no, the guard was missing"), so scanning left to right beats looking for a
 * lone keyword — and a phrase containing neither vocabulary stays unanswered.
 */
function coerceBoolean(spoken: string): boolean | null {
  for (const token of tokenize(spoken)) {
    if (AFFIRMATIVE.has(token)) return true;
    if (NEGATIVE.has(token)) return false;
  }
  return null;
}

/* ---------- numbers ---------- */

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const NEGATED = /\b(?:minus|negative)\b/;

/** How a word-level recogniser renders a decimal point: "three point five". */
const DECIMAL_WORD = 'point';

/**
 * What the least significant non-zero digit of `n` is worth — 125 -> 5,
 * 120 -> 20, 100 -> 100, 19 -> 9. `Infinity` for zero, which has no such digit
 * and so accepts any word as the start of a run.
 */
function smallestPart(n: number): number {
  for (let place = 1; place <= n; place *= 10) {
    const digit = Math.floor(n / place) % 10;
    if (digit !== 0) return digit * place;
  }
  return Infinity;
}

/**
 * Accumulate spelled-out digits ("twenty five" -> 25, "one hundred and five" -> 105).
 *
 * Leading noise is skipped but the run STOPS at the first non-number word after
 * one has started, which is what strips the unit off "twenty five kilograms"
 * without a vocabulary of every unit a form might use.
 */
function wordsToNumber(tokens: readonly string[]): number | null {
  let total = 0;
  let current = 0;
  let started = false;

  for (const token of tokens) {
    const small = NUMBER_WORDS[token];
    if (small !== undefined) {
      // A word may only fill a place the run has not used yet. Without that,
      // "nineteen ninety" added to 109 and "twenty twenty five" to 45 — two
      // spoken numbers silently turned into arithmetic nobody said, which on a
      // "year of manufacture" field is a plausible-looking wrong answer.
      if (small >= smallestPart(current)) return null;
      current += small;
      started = true;
      continue;
    }
    if (!started) continue;
    if (token === 'hundred') {
      current = (current || 1) * 100;
      continue;
    }
    if (token === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
      continue;
    }
    if (token === 'and') continue;
    break;
  }

  return started ? total + current : null;
}

/**
 * The digits after "point", concatenated as spoken — "two five" is .25, not
 * .7. Refused when the tail is not a plain digit run: "one point fifteen" has
 * two readings (1.15 and 1.fifteen-as-15) and neither is worth guessing at.
 */
function fractionDigits(tokens: readonly string[]): string | null {
  let digits = '';
  for (const token of tokens) {
    const value = NUMBER_WORDS[token];
    // A non-number word closes the fraction exactly as it closes the integer
    // run above — it is the unit, as in "three point five hours".
    if (value === undefined) break;
    if (value > 9) return null;
    digits += String(value);
  }
  return digits === '' ? null : digits;
}

/**
 * A spelled-out magnitude, decimal marker included.
 *
 * `wordsToNumber` on its own stops dead at "point" and returns the integer
 * part, so "three point five" read as 3 — and that is the shape EVERY dictated
 * decimal takes: the small Vosk model has no inverse text normalisation, so a
 * spoken 3.5 never arrives as digits. Truncating it is the one outcome this
 * module exists to prevent, since 3 looks like an answer a human chose.
 */
function spokenMagnitude(tokens: readonly string[]): number | null {
  const point = tokens.indexOf(DECIMAL_WORD);
  if (point === -1) return wordsToNumber(tokens);

  // "point five" is 0.5; reading the fraction as the whole number made it 5.
  const whole = point === 0 ? 0 : wordsToNumber(tokens.slice(0, point));
  const fraction = fractionDigits(tokens.slice(point + 1));
  if (whole === null || fraction === null) return null;
  return Number(`${whole}.${fraction}`);
}

function coerceNumber(spoken: string): number | null {
  // Thousands separators are spoken as nothing but arrive from keyboards and
  // from models that emit digits, and "1,500" must not read as 1.
  const lowered = spoken.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const digits = lowered.match(/\d+(?:\.\d+)?/);
  const magnitude = digits ? Number(digits[0]) : spokenMagnitude(tokenize(spoken));

  if (magnitude === null || !Number.isFinite(magnitude)) return null;
  return NEGATED.test(lowered) || lowered.trimStart().startsWith('-') ? -magnitude : magnitude;
}

/* ---------- dates ---------- */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};

/** Tens that can head a compound day ("twenty first", "thirty one"). */
const DAY_TENS: Record<string, number> = { twenty: 20, thirty: 30 };

/** Tens and teens that can head the second half of a spoken year ("twenty NINETY nine"). */
const YEAR_TAIL = new Set([
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety',
]);

const RELATIVE_DAYS: Record<string, number> = { today: 0, tonight: 0, tomorrow: 1, yesterday: -1 };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Local calendar parts, never `toISOString()` — the picker stores a wall-clock
 * `yyyy-mm-dd`, and UTC conversion moves "today" to yesterday for anyone east
 * of Greenwich after mid-afternoon.
 */
function formatYmd(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

function monthOf(token: string): number | null {
  if (token.length < 3) return null;
  const index = MONTHS.findIndex((m) => m.startsWith(token));
  return index === -1 ? null : index;
}

/**
 * A year, and the tokens left once it is removed.
 *
 * The century form only matches when the second word is a ten or a teen, which
 * is the whole reason "twenty five" stays the 25th while "twenty twenty five"
 * becomes 2025 — nobody says the year 2005 as "twenty five".
 */
function takeYear(tokens: readonly string[]): { year: number; rest: string[] } | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const rest = (end: number): string[] => [...tokens.slice(0, i), ...tokens.slice(end)];

    if (/^\d{4}$/.test(token)) {
      const year = Number(token);
      if (year >= 1900 && year <= 2100) return { year, rest: rest(i + 1) };
      continue;
    }

    if (token === 'two' && tokens[i + 1] === 'thousand') {
      let end = i + 2;
      while (end < tokens.length && (tokens[end] === 'and' || NUMBER_WORDS[tokens[end]!] !== undefined)) {
        end++;
      }
      const tail = wordsToNumber(tokens.slice(i + 2, end)) ?? 0;
      if (tail <= 99) return { year: 2000 + tail, rest: rest(end) };
      continue;
    }

    const century = token === 'nineteen' ? 1900 : token === 'twenty' ? 2000 : null;
    const head = tokens[i + 1];
    if (century !== null && head !== undefined && YEAR_TAIL.has(head)) {
      const tens = NUMBER_WORDS[head]!;
      const unit = tens >= 20 ? NUMBER_WORDS[tokens[i + 2] ?? ''] : undefined;
      const withUnit = unit !== undefined && unit < 10;
      return { year: century + tens + (withUnit ? unit : 0), rest: rest(i + (withUnit ? 3 : 2)) };
    }
  }
  return null;
}

/** Day of month from the first day-shaped token run. */
function takeDay(tokens: readonly string[]): number | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const tens = DAY_TENS[token];
    const next = tokens[i + 1];
    if (tens !== undefined && next !== undefined) {
      const unit = ORDINAL_WORDS[next] ?? NUMBER_WORDS[next];
      if (unit !== undefined && unit >= 1 && unit <= 9) return tens + unit;
    }

    const ordinal = ORDINAL_WORDS[token];
    if (ordinal !== undefined) return ordinal;

    if (/^\d{1,2}$/.test(token)) {
      const day = Number(token);
      if (day >= 1 && day <= 31) return day;
    }

    const cardinal = NUMBER_WORDS[token];
    if (cardinal !== undefined && cardinal >= 1 && cardinal <= 31) return cardinal;
  }
  return null;
}

/**
 * Parse to the `yyyy-mm-dd` the shared `DateTimePicker` reads and writes, so a
 * dictated date renders in the picker exactly as a tapped one does.
 *
 * A phrase with no year is dated to `now`'s year: a form being filled today
 * that says "the fifth of March" means this March, and the result is visible in
 * the picker for the respondent to correct.
 */
function coerceDate(spoken: string, now: Date): string | null {
  const iso = spoken.trim().match(ISO_DATE);
  if (iso) {
    const [year, month, day] = [Number(iso[1]!), Number(iso[2]!), Number(iso[3]!)];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) return null;
    return formatYmd(year, month - 1, day);
  }

  const tokens = tokenize(spoken);

  for (const token of tokens) {
    const offset = RELATIVE_DAYS[token];
    if (offset !== undefined) {
      const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return formatYmd(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
    }
  }

  const monthAt = tokens.findIndex((t) => monthOf(t) !== null);
  if (monthAt === -1) return null;
  const monthIndex = monthOf(tokens[monthAt]!)!;

  const withoutMonth = [...tokens.slice(0, monthAt), ...tokens.slice(monthAt + 1)];
  const year = takeYear(withoutMonth);
  const day = takeDay(year?.rest ?? withoutMonth);
  if (day === null) return null;

  const resolvedYear = year?.year ?? now.getFullYear();
  if (day > daysInMonth(resolvedYear, monthIndex)) return null;
  return formatYmd(resolvedYear, monthIndex, day);
}

/* ---------- choice fields ---------- */

/**
 * Minimum share of an option's words that must be heard before it is picked.
 * Deliberately high: "Level One" and "Level Two" overlap on half their words,
 * and picking either from "level three" would be a fabricated answer.
 */
const OPTION_MATCH_THRESHOLD = 0.6;

/** Whole-token containment — "no" must not match inside "nozzle". */
function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function overlapScore(optionTokens: readonly string[], phraseTokens: readonly string[]): number {
  const unique = [...new Set(optionTokens)];
  const spoken = new Set(phraseTokens);
  const hits = unique.filter((t) => spoken.has(t)).length;
  return hits / Math.max(unique.length, new Set(phraseTokens).size);
}

/**
 * Best option for a spoken phrase, or `null` when the choice would be a guess.
 *
 * Tried in descending order of certainty — exact, the phrase containing an
 * option, an option containing the phrase (a shortened spoken label), then word
 * overlap. Every stage refuses on a tie: two equally good options is a coin
 * flip, and the returned string is written straight into a submission.
 */
function matchOption(options: readonly string[], phrase: string): string | null {
  const phraseNorm = normalize(phrase);
  if (phraseNorm === '') return null;
  const phraseTokens = phraseNorm.split(' ');

  const candidates = options
    .map((option) => ({ option, norm: normalize(option) }))
    .filter((c) => c.norm !== '');
  if (candidates.length === 0) return null;

  const exact = candidates.find((c) => c.norm === phraseNorm);
  if (exact) return exact.option;

  // Longest wins so "pass with defects" is not truncated to "pass" — but only
  // when the shorter matches are PARTS of the longest, which is the whole of
  // what that rule was for. Two unrelated options both spoken ("medium to
  // high") is an ambiguity, and length is nothing but spelling: it answered
  // Medium there and would answer High if the author had abbreviated to "Med".
  const contained = candidates
    .filter((c) => containsPhrase(phraseNorm, c.norm))
    .sort((a, b) => b.norm.length - a.norm.length);
  const longest = contained[0];
  if (
    longest &&
    contained.every((c) => c === longest || (c.norm !== longest.norm && containsPhrase(longest.norm, c.norm)))
  ) {
    return longest.option;
  }

  const expansions = candidates.filter((c) => containsPhrase(c.norm, phraseNorm));
  if (expansions.length === 1) return expansions[0]!.option;

  const scored = candidates
    .map((c) => ({ option: c.option, score: overlapScore(c.norm.split(' '), phraseTokens) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < OPTION_MATCH_THRESHOLD) return null;
  if (scored[1] && scored[1].score >= best.score) return null;
  return best.option;
}

const LIST_SEPARATORS = /\s*(?:,|;|\band\b|\bplus\b)\s*/i;

/**
 * Split a spoken list, but only after an exact whole-phrase match has been
 * ruled out — an option authored as "Health and Safety" would otherwise be
 * shredded by its own conjunction.
 */
function coerceCheckboxGroup(field: FormField, spoken: string): string[] | null {
  const options = field.options ?? [];
  if (options.length === 0) return null;

  const picked: string[] = [];
  const whole = options.find((o) => normalize(o) === normalize(spoken));
  if (whole) {
    picked.push(whole);
  } else {
    for (const part of spoken.split(LIST_SEPARATORS)) {
      const match = matchOption(options, part);
      if (match !== null && !picked.includes(match)) picked.push(match);
    }
  }

  if (picked.length === 0) return null;
  return field.selectionType === 'single' ? [picked[0]!] : picked;
}
