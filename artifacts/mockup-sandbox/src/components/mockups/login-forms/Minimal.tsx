import { useState } from "react";

export function Minimal() {
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
    <div className="min-h-screen flex items-center justify-center bg-[#f9fafb]">
      <div className="w-full max-w-[380px] px-4">
        {/* Logo */}
        <div className="mb-10 flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#1a1f2e] flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M4 6h14M4 11h9M4 16h12" stroke="#6ee7b7" strokeWidth="2.2" strokeLinecap="round"/>
            </svg>
          </div>
          <span className="text-[22px] font-semibold tracking-tight text-gray-900">FormAI</span>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <div className="mb-6">
            <h1 className="text-[18px] font-semibold text-gray-900 mb-1">
              {step === "email" ? "Sign in" : "Enter your password"}
            </h1>
            <p className="text-[13.5px] text-gray-500">
              {step === "email"
                ? "Welcome back. Enter your email to continue."
                : <span>Signing in as <strong className="text-gray-700 font-medium">{email}</strong></span>
              }
            </p>
          </div>

          <form onSubmit={handleContinue} className="space-y-4">
            {step === "email" ? (
              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-1.5">
                  Email address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full h-10 px-3 rounded-lg border border-gray-300 text-[14px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
                  autoFocus
                />
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[13px] font-medium text-gray-700">
                    Password
                  </label>
                  <button type="button" className="text-[12px] text-emerald-600 hover:text-emerald-700 font-medium">
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-10 px-3 rounded-lg border border-gray-300 text-[14px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
                  autoFocus
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 rounded-lg bg-[#3ecf8e] hover:bg-[#36b87d] text-white text-[14px] font-semibold transition flex items-center justify-center gap-2 disabled:opacity-70"
            >
              {loading ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
              ) : step === "email" ? "Continue" : "Sign in"}
            </button>
          </form>

          {step === "email" && (
            <p className="mt-5 text-center text-[13px] text-gray-500">
              No account?{" "}
              <button className="text-emerald-600 hover:text-emerald-700 font-medium">
                Sign up for free
              </button>
            </p>
          )}

          {step === "password" && (
            <button
              onClick={() => setStep("email")}
              className="mt-4 flex items-center gap-1 text-[13px] text-gray-400 hover:text-gray-600 transition mx-auto"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Back
            </button>
          )}
        </div>

        <p className="mt-5 text-center text-[12px] text-gray-400">
          By continuing, you agree to our{" "}
          <span className="underline cursor-pointer hover:text-gray-600">Terms</span>{" "}
          and{" "}
          <span className="underline cursor-pointer hover:text-gray-600">Privacy Policy</span>.
        </p>
      </div>
    </div>
  );
}
