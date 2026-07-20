import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BrandMark } from '../../components/BrandMark.js';
import { queryClient } from '../../lib/data/hooks.js';
import { postSignInDestination, postSignupDestination } from '../../lib/onboarding-routing.js';
import { takePendingInvite } from '../../lib/pending-invite.js';

type Mode = 'signin' | 'signup';
type SigninStep = 'email' | 'password';
type AccountKind = 'individual' | 'team';

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FieldInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full h-11 px-3.5 rounded-xl border text-[14px] transition-all focus:outline-none"
      style={{ borderColor: '#e5e7eb', background: '#f9fafb', color: '#111827' }}
      onFocus={e => {
        e.currentTarget.style.background = '#fff';
        e.currentTarget.style.borderColor = '#6ec792';
        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(110,199,146,0.15)';
      }}
      onBlur={e => {
        e.currentTarget.style.background = '#f9fafb';
        e.currentTarget.style.borderColor = '#e5e7eb';
        e.currentTarget.style.boxShadow = 'none';
      }}
    />
  );
}

function AccountKindPicker({
  value,
  onChange,
}: {
  value: AccountKind;
  onChange: (v: AccountKind) => void;
}) {
  const options: { value: AccountKind; label: string; sub: string }[] = [
    { value: 'individual', label: 'Just me', sub: 'Solo workspace · 1 seat' },
    { value: 'team', label: 'My team', sub: 'Shared org · up to 5 seats' },
  ];
  return (
    <div className="flex gap-2.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className="flex-1 rounded-xl border-[1.5px] p-3 text-left transition-all"
            style={{
              borderColor: active ? '#6ec792' : '#e5e7eb',
              background: active ? 'rgba(110,199,146,0.07)' : '#f9fafb',
              boxShadow: active ? '0 0 0 3px rgba(110,199,146,0.12)' : 'none',
            }}
          >
            <div className="text-[13.5px] font-semibold" style={{ color: active ? '#253439' : '#374151' }}>
              {o.label}
            </div>
            <div className="text-[11.5px] mt-0.5" style={{ color: '#9ca3af' }}>{o.sub}</div>
          </button>
        );
      })}
    </div>
  );
}

export function LoginScreen() {
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('signin');
  const [signinStep, setSigninStep] = useState<SigninStep>('email');

  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountKind, setAccountKind] = useState<AccountKind>('team');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ── Sign-in ──────────────────────────────────────────────────────────────

  function handleEmailContinue(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSigninStep('password');
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        setError(body?.message ?? 'Invalid email or password.');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      // Pending invite first: `RootRedirect` consumes the token, but a direct
      // `navigate()` from here would bypass it and strand the invitee in their
      // own org with the invite unaccepted.
      navigate(postSignInDestination({ pendingInvite: takePendingInvite() }));
    } catch {
      setError('Unable to connect. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Sign-up ──────────────────────────────────────────────────────────────

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const body: Record<string, string> = { name, email, password, accountKind };
      if (accountKind === 'team' && orgName.trim()) {
        body.orgName = orgName.trim();
      }
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string };
        setError(data?.message ?? 'Something went wrong. Please try again.');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      // Invite before account kind — the picker defaults to `team`, so
      // branching on kind first would send an invitee to `/setup`.
      navigate(postSignupDestination({ accountKind, pendingInvite: takePendingInvite() }));
    } catch {
      setError('Unable to connect. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function switchMode(next: Mode) {
    setMode(next);
    setSigninStep('email');
    setError('');
    setPassword('');
    setName('');
    setOrgName('');
    setAccountKind('team');
  }

  const signupReady =
    !!name &&
    !!email &&
    password.length >= 8 &&
    (accountKind === 'individual' || true); // orgName is optional for team

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="fai-fade flex min-h-screen">
      {/* ── Left: form panel ─────────────────────────────────────────────── */}
      <div
        className="flex flex-1 flex-col justify-center px-8 py-12 sm:px-14"
        style={{ background: '#f0f2f5' }}
      >
        <div
          className="w-full max-w-[380px] mx-auto bg-white rounded-2xl p-8"
          style={{
            border: '1px solid rgba(0,0,0,0.06)',
            boxShadow:
              '0 1px 2px rgba(0,0,0,0.04), 0 4px 6px -1px rgba(0,0,0,0.07), 0 10px 30px -5px rgba(0,0,0,0.10)',
          }}
        >
          {/* Logo */}
          <div className="mb-9 flex items-center gap-2.5">
            <BrandMark size={30} />
            <span className="text-[18px] font-bold tracking-tight" style={{ color: '#181b19' }}>
              FormAI
            </span>
          </div>

          {/* Heading */}
          <div className="mb-6">
            <h1 className="text-[24px] font-bold tracking-tight mb-1" style={{ color: '#181b19' }}>
              {mode === 'signin' && signinStep === 'email' && 'Welcome back'}
              {mode === 'signin' && signinStep === 'password' && 'One more step'}
              {mode === 'signup' && 'Create account'}
            </h1>
            <p className="text-[14px] leading-relaxed" style={{ color: '#6b7280' }}>
              {mode === 'signin' && signinStep === 'email' && 'Sign in to your FormAI workspace.'}
              {mode === 'signin' && signinStep === 'password' && (
                <>
                  Signing in as{' '}
                  <span className="font-medium" style={{ color: '#374151' }}>{email}</span>
                </>
              )}
              {mode === 'signup' && 'Start converting PDFs in minutes.'}
            </p>
          </div>

          {/* ── Sign-in: email step ── */}
          {mode === 'signin' && signinStep === 'email' && (
            <form onSubmit={handleEmailContinue} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                  Email
                </label>
                <FieldInput
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={!email}
                className="w-full h-11 rounded-xl text-white text-[14px] font-semibold flex items-center justify-center gap-2 transition-opacity disabled:opacity-50"
                style={{ background: '#253439' }}
              >
                <span>Continue</span><ArrowRight />
              </button>

              {error && <p className="text-[13px] text-red-500">{error}</p>}

              <p className="text-center text-[13px]" style={{ color: '#9ca3af' }}>
                New here?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signup')}
                  className="font-semibold hover:opacity-80 transition-opacity"
                  style={{ color: '#6ec792' }}
                >
                  Create account
                </button>
              </p>
            </form>
          )}

          {/* ── Sign-in: password step ── */}
          {mode === 'signin' && signinStep === 'password' && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                  Password
                </label>
                <FieldInput
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoFocus
                />
              </div>

              <button
                type="submit"
                disabled={loading || !password}
                className="w-full h-11 rounded-xl text-white text-[14px] font-semibold flex items-center justify-center gap-2 transition-opacity disabled:opacity-50"
                style={{ background: '#6ec792' }}
              >
                {loading ? <Spinner /> : <><span>Sign in</span><ArrowRight /></>}
              </button>

              {error && (
                <div>
                  <p className="text-[13px] text-red-500">{error}</p>
                  {(error.toLowerCase().includes('no account') || error.toLowerCase().includes('already exists')) && (
                    <button
                      type="button"
                      onClick={() => switchMode('signup')}
                      className="text-[13px] font-semibold hover:opacity-80 transition-opacity mt-1"
                      style={{ color: '#6ec792' }}
                    >
                      Sign up instead →
                    </button>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={() => { setSigninStep('email'); setError(''); setPassword(''); }}
                className="flex items-center gap-1 text-[13px] mx-auto hover:opacity-70 transition-opacity"
                style={{ color: '#9ca3af' }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Back
              </button>
            </form>
          )}

          {/* ── Sign-up form ── */}
          {mode === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-4">
              {/* Account kind picker */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                  I'm signing up for
                </label>
                <AccountKindPicker value={accountKind} onChange={setAccountKind} />
              </div>

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                  Your name
                </label>
                <FieldInput
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Jane Smith"
                  required
                  autoFocus
                />
              </div>

              {accountKind === 'team' && (
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                    Organization name <span style={{ color: '#d1d5db' }}>(optional)</span>
                  </label>
                  <FieldInput
                    type="text"
                    value={orgName}
                    onChange={e => setOrgName(e.target.value)}
                    placeholder="Acme Corp"
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                  Email
                </label>
                <FieldInput
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: '#9ca3af' }}>
                  Password
                </label>
                <FieldInput
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min 8 characters"
                  required
                  minLength={8}
                />
              </div>

              <button
                type="submit"
                disabled={loading || !signupReady}
                className="w-full h-11 rounded-xl text-white text-[14px] font-semibold flex items-center justify-center gap-2 transition-opacity disabled:opacity-50"
                style={{ background: '#253439' }}
              >
                {loading ? <Spinner /> : 'Create account'}
              </button>

              {error && <p className="text-[13px] text-red-500">{error}</p>}

              <p className="text-center text-[13px]" style={{ color: '#9ca3af' }}>
                Have an account?{' '}
                <button
                  type="button"
                  onClick={() => switchMode('signin')}
                  className="font-semibold hover:opacity-80 transition-opacity"
                  style={{ color: '#6ec792' }}
                >
                  Sign in
                </button>
              </p>
            </form>
          )}
        </div>
      </div>

      {/* ── Right: marketing panel ────────────────────────────────────────── */}
      <div
        className="hidden lg:flex flex-1 flex-col justify-center px-14 py-12"
        style={{ background: '#1a2327' }}
      >
        <div className="max-w-[420px]">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-semibold uppercase tracking-wider mb-8"
            style={{ background: 'rgba(110,199,146,0.12)', color: '#6ec792', border: '1px solid rgba(110,199,146,0.25)' }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6ec792', display: 'inline-block' }} />
            400+ Forms · Proven at Scale
          </div>

          <h2 className="text-[36px] font-bold leading-[1.15] tracking-tight mb-5" style={{ color: '#fff' }}>
            Every PDF you already have —{' '}
            <span style={{ color: '#6ec792' }}>digital, branded, and audit-ready.</span>
          </h2>

          <p className="text-[15px] leading-relaxed mb-10" style={{ color: '#8fa3ac' }}>
            Convert existing forms with faithful round-trip fidelity, or build new ones from scratch.
            No rip-and-replace.
          </p>

          <div className="flex gap-8 mb-10">
            <div>
              <div className="text-[28px] font-bold" style={{ color: '#fff' }}>98.6%</div>
              <div className="text-[13px]" style={{ color: '#8fa3ac' }}>extraction accuracy</div>
            </div>
            <div>
              <div className="text-[28px] font-bold" style={{ color: '#fff' }}>6 min</div>
              <div className="text-[13px]" style={{ color: '#8fa3ac' }}>avg. PDF → live form</div>
            </div>
          </div>

          <blockquote
            className="rounded-2xl p-5"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <p className="text-[14px] leading-relaxed mb-4 italic" style={{ color: '#c8d8de' }}>
              "FormAI cut our compliance form update cycle from 3 weeks to 2 days."
            </p>
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold"
                style={{ background: '#6ec792', color: '#1a2327' }}
              >
                SR
              </div>
              <div>
                <div className="text-[13px] font-semibold" style={{ color: '#fff' }}>Sarah R.</div>
                <div className="text-[12px]" style={{ color: '#8fa3ac' }}>Head of Compliance, FinCorp</div>
              </div>
            </div>
          </blockquote>
        </div>
      </div>
    </div>
  );
}
