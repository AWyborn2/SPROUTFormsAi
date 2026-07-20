import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import type { BrandingKit } from '@formai/shared';
import { DEFAULT_BRANDING, FORM_FONTS, GOOGLE_FONT_FAMILIES } from '@formai/shared';
import { BrandMark } from '../../components/BrandMark.js';
import { fontStack } from '../../lib/branding.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';
import { useInviteMember, useUpdateOrg, useUploadOrgLogo } from '../../lib/data/hooks.js';
import { LogoValidationError, prepareLogoUpload } from '../../lib/logo-image.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { extractPaletteFromImageFile, mergeExtractedPalette } from '../../lib/palette-extract.js';
import {
  summarizeInviteResults,
  toRoleName,
  type InviteResult,
  type InviteSettled,
} from '../../lib/onboarding-routing.js';
import { Stepper } from './Stepper.js';

type ColorKey = 'primaryColor' | 'secondaryColor' | 'accentColor';

interface ColorRow {
  key: ColorKey;
  label: string;
  presets: string[];
}

const COLOR_ROWS: ColorRow[] = [
  {
    key: 'primaryColor',
    label: 'Primary',
    presets: ['#253439', '#181b19', '#1f3a5f', '#3d2f4f', '#0f3d3e'],
  },
  {
    key: 'secondaryColor',
    label: 'Secondary',
    presets: ['#7c898b', '#5e6a6c', '#9aa4a4', '#45504f', '#c1c8c8'],
  },
  {
    key: 'accentColor',
    label: 'Accent',
    presets: ['#6ec792', '#4f9cf9', '#e0a44f', '#f3685f', '#8b7cf6'],
  },
];

/** How many matches the results list renders before asking for a narrower query. */
const FONT_RESULT_LIMIT = 40;

/** Parse a hex or rgb() string to #rrggbb, or null if unrecognised. */
function parseColor(input: string): string | null {
  const s = input.trim();
  let m = s.match(/^#?([0-9a-f]{3})$/i);
  if (m && m[1]) {
    const c = m[1];
    return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
  }
  m = s.match(/^#?([0-9a-f]{6})$/i);
  if (m && m[1]) return `#${m[1].toLowerCase()}`;
  m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i);
  if (m) {
    const to2 = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10)))
        .toString(16)
        .padStart(2, '0');
    return `#${to2(m[1]!)}${to2(m[2]!)}${to2(m[3]!)}`;
  }
  return null;
}

/** Step 2 — the org branding kit, with a live preview of a real branded form. */
export function BrandingScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { orgName, branding, invites, setBranding, brandStyle } = useOnboarding();
  const updateOrg = useUpdateOrg();
  const inviteMember = useInviteMember();
  const uploadLogo = useUploadOrgLogo();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoName, setLogoName] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(null);

  const orgInitial = (orgName.trim()[0] ?? '?').toUpperCase();

  // The live preview renders `var(--org-font)`, which only names the family —
  // load it whenever the selection changes (including on resume, where the
  // saved kit arrives without the picker having been touched).
  useEffect(() => {
    ensureFontLoaded(branding.formFont);
  }, [branding.formFont]);

  /**
   * Validate → rasterise (SVG only) → upload → hold the returned public URL
   * in wizard state. Nothing persists until "Finish setup" writes the whole
   * branding kit; a failure here is inline and non-blocking, so the user can
   * always finish without a logo.
   */
  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setLogoError(null);
    try {
      const prepared = await prepareLogoUpload(file);
      const { url } = await uploadLogo.mutateAsync(prepared);
      setBranding({ logoAssetUrl: url });
      setLogoName(file.name);
    } catch (err) {
      setLogoError(
        err instanceof LogoValidationError
          ? err.message
          : 'That logo could not be uploaded — you can continue and add one later.',
      );
      return;
    }
    await prefillPalette(file);
  };

  /**
   * Pre-fill the palette from the logo's own colours (R7). Read from the
   * local file rather than the uploaded URL — the bytes are already here and
   * a same-origin blob can't taint the canvas. Deliberately outside the
   * upload try/catch: extraction is cosmetic, so a failure must never surface
   * as an upload error. Only fields still at their defaults are written, so a
   * colour the user picked by hand survives a re-upload, and every field
   * stays editable afterwards.
   */
  const prefillPalette = async (file: File) => {
    const extracted = await extractPaletteFromImageFile(file);
    const patch = mergeExtractedPalette(branding, extracted, DEFAULT_BRANDING);
    if (Object.keys(patch).length > 0) setBranding(patch);
  };

  const removeLogo = () => {
    setBranding({ logoAssetUrl: null });
    setLogoName(null);
    setLogoError(null);
  };

  /**
   * Persist the wizard's choices and stamp onboarding complete via `PATCH /org`,
   * then send the Step 1 invite rows. An empty name is dropped so we never
   * overwrite the auto-provisioned org name with ''; if the save itself fails we
   * stay on this step so the user can retry.
   *
   * Invites are best-effort and deliberately do not gate completion — a seat
   * limit or a bad address must not trap someone in the wizard. Because the
   * Step 1 rows are off-screen by now, the per-email outcome renders here
   * before the transition to the app.
   */
  const finishSetup = async () => {
    setFinishing(true);
    const name = orgName.trim();
    const payload = { branding, onboardingComplete: true as const };
    try {
      await updateOrg.mutateAsync(name ? { name, ...payload } : payload);
    } catch {
      setFinishing(false);
      toast({
        variant: 'danger',
        message: 'Could not save your organisation settings — try again.',
      });
      return;
    }

    const rows = invites.filter((inv) => inv.email.trim());
    if (rows.length === 0) {
      navigate('/app');
      return;
    }

    const settled = await Promise.all(
      rows.map(async (inv): Promise<InviteSettled> => {
        const email = inv.email.trim();
        try {
          const value = await inviteMember.mutateAsync({ email, role: toRoleName(inv.role) });
          return { email, ok: true, value: value ? { emailSent: value.emailSent } : null };
        } catch (error) {
          return { email, ok: false, error };
        }
      }),
    );
    setInviteResults(summarizeInviteResults(settled).results);
    setFinishing(false);
  };

  return (
    <div className="fai-fade flex min-h-screen flex-col items-center px-6 py-12">
      <div className="w-full max-w-[1000px]">
        <div className="mb-[30px] flex items-center gap-3">
          <BrandMark size={26} />
          <span className="font-heading text-lg font-bold tracking-tight">FormAI</span>
        </div>
        <Stepper active={1} />

        <div className="grid grid-cols-1 items-start gap-[26px] md:grid-cols-2">
          {/* Config */}
          <div className="rounded-xl border border-border bg-surface-card p-8 shadow-sm">
            <div className="mb-2.5 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
              Step 2 · Branding kit
            </div>
            <h3 className="mb-1.5 text-2xl">Make forms carry your brand</h3>
            <p className="mb-6 text-sm text-text-secondary">
              External forms — vendor onboarding, customer intake — go out under your identity, not
              ours.
            </p>

            {/* Logo */}
            <div className="mb-[9px] text-[13px] font-semibold">Logo</div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/svg+xml,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                void onPickFile(e.target.files?.[0]);
                // Reset so re-picking the same file still fires onChange.
                e.target.value = '';
              }}
            />
            <div className="mb-[22px]">
              {branding.logoAssetUrl ? (
                <div className="flex items-center gap-[13px] rounded-md border-[1.5px] border-border bg-surface-sunken p-[14px]">
                  <img
                    src={branding.logoAssetUrl}
                    alt="Your uploaded logo"
                    className="h-11 w-11 flex-none rounded-[10px] border border-border bg-white object-contain p-1"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-ui text-[13.5px] font-semibold text-text-primary">
                      {logoName ?? 'Your logo'}
                    </span>
                    <span className="block text-xs text-text-tertiary">
                      Shown on every branded form
                    </span>
                  </div>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadLogo.isPending}
                    className="fai-chip-btn rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-text-secondary"
                  >
                    Replace
                  </button>
                  <button
                    onClick={removeLogo}
                    className="fai-chip-btn rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-text-secondary"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadLogo.isPending}
                  className="fai-chip-btn flex w-full items-center gap-[13px] rounded-md border-[1.5px] border-dashed border-border-strong bg-surface-sunken p-[14px] text-left"
                >
                  <span
                    className="grid h-11 w-11 flex-none place-items-center rounded-[10px] font-heading text-[17px] font-bold text-white"
                    style={{ background: branding.primaryColor }}
                  >
                    {orgInitial}
                  </span>
                  <span className="flex-1">
                    <span className="block font-ui text-[13.5px] font-semibold text-text-primary">
                      {uploadLogo.isPending ? 'Uploading…' : 'Upload your logo'}
                    </span>
                    <span className="block text-xs text-text-tertiary">
                      SVG, PNG, JPEG or WebP · up to 2 MB
                    </span>
                  </span>
                  <Icon name="upload" size={17} className="text-text-tertiary" />
                </button>
              )}
              {logoError && (
                <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                  <Icon name="info" size={13} className="mt-px flex-none" />
                  {logoError}
                </p>
              )}
            </div>

            {/* Colours */}
            <div className="mb-[11px] text-[13px] font-semibold">Brand colours</div>
            <div className="mb-[22px] flex flex-col gap-[13px]">
              {COLOR_ROWS.map((row) => (
                <ColorRowControl
                  key={row.key}
                  row={row}
                  value={branding[row.key]}
                  onPick={(hex) => setBranding({ [row.key]: hex } as Partial<BrandingKit>)}
                />
              ))}
            </div>

            {/* Font */}
            <div className="mb-[9px] text-[13px] font-semibold">Form font</div>
            <FontPicker
              value={branding.formFont}
              onPick={(family) => setBranding({ formFont: family })}
            />
          </div>

          {/* Live preview */}
          <div className="sticky top-4">
            <div className="mb-[11px] flex items-center gap-2">
              <Icon name="eye" size={15} className="text-accent" />
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
                Live preview · vendor onboarding
              </span>
            </div>
            <div
              className="overflow-hidden rounded-lg border border-border shadow-md"
              style={brandStyle()}
            >
              <div
                className="flex h-[88px] items-center gap-3 px-[26px]"
                style={{ background: 'var(--org-primary)' }}
              >
                {branding.logoAssetUrl ? (
                  <img
                    src={branding.logoAssetUrl}
                    alt=""
                    className="h-10 w-10 flex-none rounded-[9px] bg-white/[0.14] object-contain p-1"
                  />
                ) : (
                  <span className="grid h-10 w-10 place-items-center rounded-[9px] bg-white/[0.14] font-heading text-[17px] font-bold text-white">
                    {orgInitial}
                  </span>
                )}
                <div>
                  <div
                    className="text-[17px] font-bold text-white"
                    style={{ fontFamily: 'var(--org-font)' }}
                  >
                    {orgName}
                  </div>
                  <div className="text-[11.5px] text-white/60">Vendor onboarding</div>
                </div>
              </div>
              <div className="bg-white px-[26px] py-6" style={{ fontFamily: 'var(--org-font)' }}>
                <div
                  className="mb-1 text-lg font-bold text-[#1a2224]"
                  style={{ fontFamily: 'var(--org-font)' }}
                >
                  Supplier details
                </div>
                <div className="mb-[18px] text-[12.5px] text-[#6b7677]">
                  Fields marked * are required.
                </div>
                <div className="mb-[14px]">
                  <div className="mb-[5px] text-xs font-semibold text-[#33403f]">
                    Legal entity name *
                  </div>
                  <div className="h-[38px] rounded-lg border border-[#d9dede] bg-[#fbfcfc]" />
                </div>
                <div className="mb-[18px]">
                  <div className="mb-[5px] text-xs font-semibold text-[#33403f]">
                    Business category *
                  </div>
                  <div className="flex h-[38px] items-center justify-end rounded-lg border border-[#d9dede] bg-[#fbfcfc] px-3">
                    <Icon name="chevron-down" size={15} color="#9aa4a4" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <div
                    className="rounded-lg px-5 py-2.5 text-[13.5px] font-bold"
                    style={{
                      background: 'var(--org-accent)',
                      color: 'var(--org-accent-text)',
                      fontFamily: 'var(--org-font)',
                    }}
                  >
                    Submit application
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-text-tertiary">
              <Icon name="info" size={13} />
              Green passes contrast only with dark text on top — we lock the button label to ink
              automatically.
            </p>
          </div>
        </div>

        {inviteResults && <InviteResultsPanel results={inviteResults} />}

        <div className="mt-[26px] flex max-w-[1000px] items-center justify-between">
          {inviteResults ? (
            <span className="text-[13.5px] text-text-tertiary">
              Your organisation is set up — you can manage invites from Team.
            </span>
          ) : (
            <Link to="/setup" className="text-[13.5px] text-text-tertiary">
              Back
            </Link>
          )}
          {inviteResults ? (
            <Button onClick={() => navigate('/app')}>Go to dashboard</Button>
          ) : (
            <Button onClick={() => void finishSetup()} loading={finishing}>
              Finish setup
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-email invite outcome, shown on the finish step because the rows that
 * produced it were entered on Step 1 and are no longer visible. Failures are
 * informational: the org is already set up by the time this renders.
 */
function InviteResultsPanel({ results }: { results: InviteResult[] }) {
  const failed = results.filter((r) => r.status === 'failed').length;
  return (
    <div
      role="status"
      className="mt-[26px] rounded-xl border border-border bg-surface-card p-[22px] shadow-sm"
    >
      <div className="mb-1 text-[15px] font-semibold">
        {failed === 0
          ? 'Invites sent'
          : `${results.length - failed} of ${results.length} invites sent`}
      </div>
      <p className="mb-[13px] text-[13px] text-text-secondary">
        Setup is complete either way — anything that failed can be retried from the Team screen.
      </p>
      <ul className="flex flex-col gap-[7px]">
        {results.map((r) => (
          <li key={r.email} className="flex items-start gap-2.5 text-[13px]">
            <Icon
              name={r.status === 'failed' ? 'info' : 'check'}
              size={14}
              className={`mt-0.5 flex-none ${r.status === 'failed' ? 'text-danger' : 'text-accent'}`}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-text-primary">{r.email}</span>{' '}
              <span className="text-text-tertiary">— {r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Font selection: four quick picks over a text-filtered listbox of the whole
 * bundled Google Fonts catalog. Deliberately *not* a free-text field — the
 * value is persisted and validated against the same catalog server-side, so
 * anything typed can only ever select, never submit.
 */
function FontPicker({ value, onPick }: { value: string; onPick: (family: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The quick picks render their own name as a specimen, so each needs its
  // stylesheet — this is precisely the bug the old picker had with Spectral.
  useEffect(() => {
    for (const family of FORM_FONTS) ensureFontLoaded(family);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q ? GOOGLE_FONT_FAMILIES.filter((f) => f.toLowerCase().includes(q)) : [];
    return pool.slice(0, FONT_RESULT_LIMIT);
  }, [query]);

  const select = (family: string) => {
    onPick(family);
    setQuery('');
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        e.key === 'ArrowDown'
          ? (active + 1) % matches.length
          : (active - 1 + matches.length) % matches.length;
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const family = matches[active];
      if (family) select(family);
    } else if (e.key === 'Escape') {
      setQuery('');
      setActive(0);
    }
  };

  return (
    <div>
      <div className="mb-2 flex gap-2">
        {FORM_FONTS.map((family) => {
          const selected = value === family;
          return (
            <button
              key={family}
              onClick={() => select(family)}
              aria-pressed={selected}
              className="fai-chip-btn flex-1 rounded-md border-[1.5px] px-2 py-[11px] text-center"
              style={{
                borderColor: selected ? 'var(--border-accent)' : 'var(--border-default)',
                background: selected ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
              }}
            >
              <span
                className="block text-[17px] font-semibold text-text-primary"
                style={{ fontFamily: fontStack(family) }}
              >
                Ag
              </span>
              <span className="mt-[3px] block truncate text-[11px] text-text-tertiary">
                {family}
              </span>
            </button>
          );
        })}
      </div>

      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={query.trim().length > 0}
        aria-controls="font-results"
        aria-autocomplete="list"
        aria-label="Search all Google Fonts"
        placeholder="Search all Google Fonts…"
        className="h-[34px] w-full rounded-md border border-border bg-surface-sunken px-[9px] text-[13px] text-text-primary"
      />

      {query.trim().length > 0 &&
        (matches.length === 0 ? (
          <p className="mt-2 px-[9px] text-xs text-text-tertiary">No fonts found.</p>
        ) : (
          <ul
            id="font-results"
            ref={listRef}
            role="listbox"
            aria-label="Google Fonts"
            className="fai-scroll mt-2 max-h-[190px] overflow-auto rounded-md border border-border bg-surface-card"
          >
            {matches.map((family, i) => (
              <li key={family} role="option" aria-selected={value === family}>
                <button
                  onClick={() => select(family)}
                  onMouseEnter={() => setActive(i)}
                  className="flex w-full items-center justify-between px-[11px] py-[7px] text-left text-[13px] text-text-primary"
                  style={{
                    background: i === active ? 'var(--surface-accent-soft)' : 'transparent',
                  }}
                >
                  <span className="truncate">{family}</span>
                  {value === family && (
                    <Icon name="check" size={13} className="flex-none text-accent" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ))}

      <p className="mt-2 text-[11.5px] text-text-tertiary">
        Selected: <span style={{ fontFamily: fontStack(value) }}>{value}</span>
      </p>
    </div>
  );
}

function ColorRowControl({
  row,
  value,
  onPick,
}: {
  row: ColorRow;
  value: string;
  onPick: (hex: string) => void;
}) {
  return (
    <div>
      <div className="mb-[7px] flex justify-between">
        <span className="text-[12.5px] text-text-secondary">{row.label}</span>
        <span className="font-mono text-[11.5px] text-text-tertiary">{value}</span>
      </div>
      <div className="flex gap-[7px]">
        {row.presets.map((hex) => (
          <button
            key={hex}
            onClick={() => onPick(hex)}
            aria-label={hex}
            className="h-[30px] w-[38px] rounded-lg shadow-xs"
            style={{
              background: hex,
              border: `2px solid ${value.toLowerCase() === hex.toLowerCase() ? '#181b19' : 'transparent'}`,
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-[7px]">
        <input
          type="color"
          value={value}
          onChange={(e) => onPick(e.target.value)}
          aria-label={`Pick a custom ${row.label.toLowerCase()} colour`}
          className="h-[30px] w-[34px] flex-none cursor-pointer rounded-md border border-border bg-surface-card p-0.5"
        />
        <input
          defaultValue={value}
          key={value}
          onBlur={(e) => {
            const parsed = parseColor(e.target.value);
            if (parsed) onPick(parsed);
          }}
          placeholder="#RRGGBB or rgb(0,0,0)"
          className="h-[30px] min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-[9px] font-mono text-xs text-text-primary"
        />
      </div>
    </div>
  );
}
