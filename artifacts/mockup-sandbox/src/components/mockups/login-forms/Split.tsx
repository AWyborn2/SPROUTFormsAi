import { useState } from "react";

export function Split() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"email" | "password">("email");
  const [loading, setLoading] = useState(false);

  function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    if (step === "email" && email) {
      setStep("password");
    } else if (step === "password" && password) {
      setLoading(true);
      setTimeout(() => setLoading(false), 1200);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left — form */}
      <div className="flex flex-1 flex-col justify-center px-14 py-12 bg-[#f0f2f5]">
        <div className="w-full max-w-[360px] mx-auto bg-white rounded-2xl border border-gray-100 p-8" style={{ boxShadow: "0 4px 6px -1px rgba(0,0,0,0.07), 0 10px 30px -5px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.04)" }}>
          {/* Logo */}
          <div className="mb-10 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#1a1f2e] flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 5h12M3 9h7M3 13h10" stroke="#6ee7b7" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <span className="text-[18px] font-bold tracking-tight text-gray-900">FormAI</span>
          </div>

          {/* Heading */}
          <div className="mb-7">
            <h1 className="text-[26px] font-bold tracking-tight text-gray-900 mb-1.5">
              {step === "email" ? "Welcome back" : "One more step"}
            </h1>
            <p className="text-[14px] text-gray-500 leading-relaxed">
              {step === "email"
                ? "Sign in to your FormAI workspace."
                : <>Entering password for <span className="font-medium text-gray-700">{email}</span></>
              }
            </p>
          </div>

          <form onSubmit={handleContinue} className="space-y-4">
            {step === "email" ? (
              <div>
                <label className="block text-[13px] font-semibold text-gray-600 mb-1.5 uppercase tracking-wider">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full h-11 px-3.5 rounded-xl border border-gray-200 bg-gray-50 text-[14px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#3ecf8e] focus:border-transparent focus:bg-white transition"
                  autoFocus
                />
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[13px] font-semibold text-gray-600 uppercase tracking-wider">
                    Password
                  </label>
                  <button type="button" className="text-[12px] text-[#3ecf8e] hover:text-[#36b87d] font-semibold">
                    Forgot?
                  </button>
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-11 px-3.5 rounded-xl border border-gray-200 bg-gray-50 text-[14px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#3ecf8e] focus:border-transparent focus:bg-white transition"
                  autoFocus
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 rounded-xl hover:bg-[#252d42] text-white text-[14px] font-semibold transition flex items-center justify-center gap-2 disabled:opacity-60 bg-[#36b87d]"
            >
              {loading ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
              ) : (
                <>
                  {step === "email" ? "Continue" : "Sign in"}
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </>
              )}
            </button>
          </form>

          <div className="mt-5 flex items-center justify-between text-[13px] text-gray-400">
            {step === "password" ? (
              <button
                onClick={() => setStep("email")}
                className="flex items-center gap-1 hover:text-gray-600 transition"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Back
              </button>
            ) : (
              <span>
                New here?{" "}
                <button className="text-[#3ecf8e] hover:text-[#36b87d] font-semibold">
                  Create account
                </button>
              </span>
            )}
          </div>
        </div>
      </div>
      {/* Right — hero */}
      <div className="hidden lg:flex flex-1 flex-col justify-center relative overflow-hidden bg-[#1a1f2e] px-14 py-12">
        {/* Glow */}
        <div
          className="absolute inset-0 opacity-60"
          style={{
            background: "radial-gradient(ellipse 80% 60% at 80% 20%, rgba(62,207,142,0.18) 0%, transparent 60%)",
          }}
        />

        {/* Grid lines subtle */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />

        <div className="relative max-w-[400px]">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-1.5 mb-7">
            <div className="w-1.5 h-1.5 rounded-full bg-[#3ecf8e]" />
            <span className="text-[11px] font-mono tracking-widest text-[#8fd6ad] uppercase">
              400+ forms · proven at scale
            </span>
          </div>

          <h2 className="text-[32px] font-bold leading-[1.25] tracking-tight text-white mb-4">
            Every PDF you already have —{" "}
            <span className="text-[#6ee7b7]">digital, branded, and audit-ready.</span>
          </h2>

          <p className="text-[15px] leading-relaxed text-white/60 mb-10">
            Convert existing forms with faithful round-trip fidelity, or build new ones from scratch.
          </p>

          {/* Stats */}
          <div className="flex gap-8">
            {[
              { value: "98.6%", label: "extraction accuracy" },
              { value: "6 min", label: "avg. PDF → live form" },
            ].map(stat => (
              <div key={stat.label}>
                <div className="text-[28px] font-bold text-white tracking-tight">{stat.value}</div>
                <div className="text-[12px] text-white/50 mt-0.5">{stat.label}</div>
              </div>
            ))}
          </div>

          {/* Fake testimonial */}
          <div className="mt-10 rounded-xl border border-white/10 bg-white/5 px-5 py-4 backdrop-blur-sm">
            <p className="text-[13px] text-white/70 leading-relaxed italic">
              "FormAI cut our compliance form update cycle from 3 weeks to 2 days."
            </p>
            <div className="mt-3 flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-[#3ecf8e]/30 flex items-center justify-center text-[11px] font-bold text-[#6ee7b7]">
                SR
              </div>
              <div>
                <div className="text-[12px] font-semibold text-white/80">Sarah R.</div>
                <div className="text-[11px] text-white/40">Head of Compliance, FinCorp</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
