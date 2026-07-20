import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '@formai/ui';
import { NAV_SCREENS, screenByPath } from '../lib/screens.js';
import { useKeyboard } from '../lib/keyboard/KeyboardProvider.js';
import { useSession } from '../lib/data/hooks.js';
import { orgBrandVars } from '../lib/branding.js';
import { useTheme } from '../lib/theme.js';
import { MOD_LABEL } from '../lib/keyboard/platform.js';
import { BrandMark } from '../components/BrandMark.js';
import { AccountMenu } from '../components/AccountMenu.js';

/** The authenticated app shell: slate sidebar + topbar + routed content. */
export function AppShell() {
  const { openPalette, openShortcuts } = useKeyboard();
  const { theme, toggle } = useTheme();
  const { data: session } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const current = screenByPath(location.pathname);
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
          {NAV_SCREENS.map((s) => (
            <NavLink
              key={s.key}
              to={s.path}
              end={s.path === '/app'}
              className={({ isActive }) =>
                [
                  'mb-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-[rgba(110,199,146,0.14)] font-semibold text-white'
                    : 'font-medium text-white/75 hover:bg-white/5',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    name={s.icon}
                    size={17}
                    color={isActive ? '#8fd6ad' : 'rgba(255,255,255,.55)'}
                  />
                  {s.label}
                </>
              )}
            </NavLink>
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
        <main className="fai-scroll flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
