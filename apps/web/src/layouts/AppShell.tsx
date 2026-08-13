import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '@formai/ui';
import { navSectionsFor, screenByPath, type NavSection, type ScreenDef } from '../lib/screens.js';
import { useKeyboard } from '../lib/keyboard/KeyboardProvider.js';
import { useSession } from '../lib/data/hooks.js';
import { orgBrandVars } from '../lib/branding.js';
import { useTheme } from '../lib/theme.js';
import { MOD_LABEL } from '../lib/keyboard/platform.js';
import { BrandMark } from '../components/BrandMark.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { FinishBrandingBanner } from '../components/FinishBrandingBanner.js';
import {
  BADGE_CONTEXT,
  badgeFor,
  groupRollup,
  NavCountPill,
  useNavBadgeCounts,
  type NavBadgeCounts,
} from './nav-badges.js';

/** The authenticated app shell: slate sidebar + topbar + routed content. */
export function AppShell() {
  const { openPalette, openShortcuts } = useKeyboard();
  const { theme, toggle } = useTheme();
  const { data: session } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const current = screenByPath(location.pathname);
  /*
    The plan features ride the SESSION, so the nav is right on first paint. A
    separate billing call would leave every gated entry flickering in once it
    returned.
  */
  const { top, groups } = navSectionsFor(session?.role, session?.features);
  /*
    Work-queue counts for the badges (R5–R7). Computed once here — a group
    header needs its children's counts to roll up while collapsed, so the
    counts cannot live inside the per-entry components.
  */
  const visibleKeys = new Set([...top, ...groups.flatMap((g) => g.screens)].map((s) => s.key));
  const badgeCounts = useNavBadgeCounts(visibleKeys, session?.role);
  const userName = session?.userName || session?.userEmail || 'Account';
  const orgName = session?.orgName || 'Your organization';
  const orgInitial = (orgName.trim()[0] ?? '?').toUpperCase();
  const orgLogoUrl = session?.branding?.logoAssetUrl ?? null;
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  return (
    // The org's kit rides the same `--org-*` token pipe the fill views use
    // (R13), so widening coverage later is a styling change, not a rewire.
    // Accent-level only (R12): the chrome's surfaces, nav, and semantic
    // colours stay product-owned.
    <div
      className="flex h-screen overflow-hidden bg-surface-page text-text-primary"
      style={orgBrandVars(session?.branding)}
    >
      {/* Sidebar */}
      <aside className="flex w-60 flex-none flex-col bg-brand-slate text-white">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <BrandMark variant="dark" size={26} />
          <span className="font-heading text-lg font-bold tracking-tight">FormAI</span>
        </div>
        <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2">
          {orgLogoUrl ? (
            <img
              src={orgLogoUrl}
              alt=""
              className="h-[26px] w-[26px] flex-none rounded-[7px] bg-white/10 object-contain"
            />
          ) : (
            <span
              className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] font-heading text-[13px] font-bold"
              style={{ background: 'var(--org-accent)', color: 'var(--org-accent-text)' }}
            >
              {orgInitial}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-white">{orgName}</span>
            <span className="block text-[11px] text-white/50">Business plan</span>
          </span>
          <Icon name="chevrons-up-down" size={15} color="rgba(255,255,255,.4)" />
        </div>
        <nav className="fai-scroll flex-1 overflow-auto px-2 py-2">
          {top.map((s) => (
            <NavItem key={s.key} screen={s} badgeCounts={badgeCounts} />
          ))}
          {groups.map((g) => (
            <NavGroup
              key={g.key}
              section={g}
              pathname={location.pathname}
              badgeCounts={badgeCounts}
            />
          ))}
        </nav>
        <div className="border-t border-white/[0.08] p-3">
          <button
            onClick={openShortcuts}
            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[13px] text-white/70 transition-colors hover:bg-white/5"
          >
            <Icon name="keyboard" size={17} />
            <span className="flex-1">Shortcuts</span>
            <span className="kbd-dark">?</span>
          </button>
          <div className="relative mt-0.5">
            <button
              onClick={() => setAccountMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/5"
            >
              <Avatar name={userName} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-white">
                  {userName}
                </span>
                <span className="block truncate text-[11px] capitalize text-white/50">
                  {session?.role ?? ''}
                </span>
              </span>
              <Icon name="chevrons-up-down" size={14} color="rgba(255,255,255,.4)" />
            </button>
            <AccountMenu
              open={accountMenuOpen}
              onClose={() => setAccountMenuOpen(false)}
              onLoggedOut={() => navigate('/login', { replace: true })}
            />
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-none items-center gap-3 border-b border-border bg-surface-card px-6">
          <h1 className="flex-1 truncate text-base font-semibold">
            {current?.label ?? 'FormAI'}
          </h1>
          <button
            onClick={openPalette}
            className="fai-chip-btn flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-text-secondary hover:bg-surface-hover"
          >
            <Icon name="search" size={13} />
            Search
            <span className="kbd">{MOD_LABEL}K</span>
          </button>
          <button
            onClick={toggle}
            aria-label="Toggle theme"
            className="grid h-8 w-8 place-items-center rounded-md text-text-secondary hover:bg-surface-hover"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
          <button
            onClick={openShortcuts}
            aria-label="Keyboard shortcuts"
            className="grid h-8 w-8 place-items-center rounded-md border border-border text-text-secondary hover:bg-surface-hover"
          >
            <span className="font-mono text-[13px] font-semibold">?</span>
          </button>
        </header>
        <FinishBrandingBanner />
        <main className="fai-scroll flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function NavItem({
  screen,
  nested = false,
  badgeCounts,
}: {
  screen: ScreenDef;
  nested?: boolean;
  badgeCounts?: NavBadgeCounts;
}) {
  const badge = badgeFor(badgeCounts, screen.key);
  return (
    <NavLink
      to={screen.path}
      end={screen.path === '/app'}
      className={({ isActive }) =>
        [
          'mb-0.5 flex items-center gap-3 rounded-md py-2 text-sm transition-colors',
          nested ? 'pl-[34px] pr-3' : 'px-3',
          isActive
            ? 'bg-[rgba(110,199,146,0.14)] font-semibold text-white'
            : 'font-medium text-white/75 hover:bg-white/5',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            name={screen.icon}
            size={nested ? 16 : 17}
            color={isActive ? '#8fd6ad' : 'rgba(255,255,255,.55)'}
          />
          {screen.label}
          {badge !== null && (
            <NavCountPill count={badge} context={BADGE_CONTEXT[screen.key as keyof NavBadgeCounts]} />
          )}
        </>
      )}
    </NavLink>
  );
}

/** Remembered per group so a preference survives navigation and reloads. */
function storedNavOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('fai-nav-open') ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * A collapsible sidebar section.
 *
 * Closed by default UNLESS the current screen lives inside it — landing on
 * Billing must not hide Billing — and a member's own toggle wins over both
 * from then on. That default is what actually shortens the sidebar: the
 * settings surfaces are visited rarely, so they spend most of their life as
 * one row instead of nine.
 */
function NavGroup({
  section,
  pathname,
  badgeCounts,
}: {
  section: NavSection;
  pathname: string;
  badgeCounts?: NavBadgeCounts;
}) {
  const [override, setOverride] = useState<boolean | undefined>(() => storedNavOpen()[section.key]);
  const containsActive = section.screens.some(
    (s) => pathname === s.path || pathname.startsWith(`${s.path}/`),
  );
  const open = override ?? containsActive;
  // Badged children live INSIDE this collapsible group — while it is closed
  // their pills do not exist, so the header carries their sum (see groupRollup).
  const rollup = groupRollup(badgeCounts, section.screens.map((s) => s.key));

  function toggle() {
    const next = !open;
    setOverride(next);
    try {
      localStorage.setItem(
        'fai-nav-open',
        JSON.stringify({ ...storedNavOpen(), [section.key]: next }),
      );
    } catch {
      /* Private-mode storage failures only lose the preference, not the nav. */
    }
  }

  return (
    <div className="mt-1">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-white/75 transition-colors hover:bg-white/5"
      >
        <Icon
          name={section.icon}
          size={17}
          color={containsActive && !open ? '#8fd6ad' : 'rgba(255,255,255,.55)'}
        />
        <span className="flex-1">{section.label}</span>
        {!open && rollup > 0 && (
          <NavCountPill count={rollup} context={`items waiting in ${section.label}`} />
        )}
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={14}
          color="rgba(255,255,255,.4)"
        />
      </button>
      {open &&
        section.screens.map((s) => (
          <NavItem key={s.key} screen={s} nested badgeCounts={badgeCounts} />
        ))}
    </div>
  );
}
