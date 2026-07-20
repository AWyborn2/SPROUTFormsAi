import { useState } from "react";

function BrandMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8" fill="#253439" />
      <rect x="7" y="8.5" width="13" height="2.6" rx="1.3" fill="#7c8b8d" />
      <rect x="7" y="14" width="9" height="2.6" rx="1.3" fill="#7c8b8d" />
      <path
        d="M12.4 21.2 L15.6 24.4 L24.2 14.6"
        stroke="#6ec792"
        strokeWidth="3.1"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

export function SplitB() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"email" | "password">("email");
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step === "email" && email) {
      setStep("password");
    } else if (step === "password" && password) {
      setLoading(true);
      setTimeout(() => setLoading(false), 1400);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex" }}>
      {/* Left — pure white, form floats */}
      <div
        style={{
          flex: "0 0 45%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: "40px 32px",
          background: "#ffffff",
          position: "relative",
        }}
      >
        {/* Subtle top-left corner accent */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "180px",
            height: "180px",
            background: "radial-gradient(circle at 0% 0%, rgba(110,199,146,0.07) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        <div
          style={{
            width: "100%",
            maxWidth: "340px",
            background: "#fff",
            borderRadius: "24px",
            padding: "36px 32px 30px",
            border: "1px solid #f0f0f0",
            boxShadow:
              "0 0 0 1px rgba(0,0,0,0.03), 0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.08), 0 32px 64px rgba(0,0,0,0.06)",
          }}
        >
          {/* Logo */}
          <div style={{ marginBottom: "30px", display: "flex", alignItems: "center", gap: "10px" }}>
            <BrandMark />
            <span style={{ fontSize: "17px", fontWeight: 700, letterSpacing: "-0.3px", color: "#0f172a" }}>
              FormAI
            </span>
          </div>

          {/* Heading */}
          <div style={{ marginBottom: "22px" }}>
            <h1 style={{ fontSize: "23px", fontWeight: 700, letterSpacing: "-0.5px", color: "#0f172a", margin: "0 0 6px" }}>
              {step === "email" ? "Sign in" : "Enter password"}
            </h1>
            <p style={{ fontSize: "13.5px", color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
              {step === "email"
                ? "Welcome back to your workspace."
                : <>{" "}<span style={{ color: "#374151", fontWeight: 500 }}>{email}</span></>}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            {step === "email" ? (
              <div style={{ marginBottom: "12px" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    color: "#6b7280",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    marginBottom: "7px",
                  }}
                >
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoFocus
                  style={{
                    width: "100%",
                    height: "46px",
                    padding: "0 14px",
                    borderRadius: "11px",
                    border: "1.5px solid #e8eaed",
                    background: "#fafafa",
                    fontSize: "14px",
                    color: "#111827",
                    outline: "none",
                    transition: "all 0.15s",
                    boxSizing: "border-box",
                  }}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = "#6ec792";
                    e.currentTarget.style.background = "#fff";
                    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(110,199,146,0.12)";
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = "#e8eaed";
                    e.currentTarget.style.background = "#fafafa";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                />
              </div>
            ) : (
              <div style={{ marginBottom: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "7px" }}>
                  <label
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 600,
                      color: "#6b7280",
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    Password
                  </label>
                  <button
                    type="button"
                    style={{ fontSize: "12px", color: "#6ec792", fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                  >
                    Forgot?
                  </button>
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoFocus
                  style={{
                    width: "100%",
                    height: "46px",
                    padding: "0 14px",
                    borderRadius: "11px",
                    border: "1.5px solid #e8eaed",
                    background: "#fafafa",
                    fontSize: "14px",
                    color: "#111827",
                    outline: "none",
                    transition: "all 0.15s",
                    boxSizing: "border-box",
                  }}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = "#6ec792";
                    e.currentTarget.style.background = "#fff";
                    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(110,199,146,0.12)";
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = "#e8eaed";
                    e.currentTarget.style.background = "#fafafa";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (step === "email" ? !email : !password)}
              style={{
                width: "100%",
                height: "46px",
                marginTop: "4px",
                borderRadius: "11px",
                background: loading
                  ? "#4fb27b"
                  : "linear-gradient(160deg, #6ec792 0%, #3a9c66 100%)",
                color: "#fff",
                fontSize: "14px",
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "7px",
                opacity: loading || (step === "email" ? !email : !password) ? 0.55 : 1,
                transition: "all 0.15s",
                boxShadow: "0 2px 8px rgba(58,156,102,0.35), 0 1px 2px rgba(58,156,102,0.2)",
              }}
              onMouseEnter={e => {
                if (!loading) {
                  e.currentTarget.style.boxShadow = "0 4px 14px rgba(58,156,102,0.4), 0 1px 2px rgba(58,156,102,0.2)";
                  e.currentTarget.style.transform = "translateY(-1px)";
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.boxShadow = "0 2px 8px rgba(58,156,102,0.35), 0 1px 2px rgba(58,156,102,0.2)";
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              {loading ? <Spinner /> : <>{step === "email" ? "Continue" : "Sign in"} <ArrowRight /></>}
            </button>
          </form>

          {/* Footer */}
          <div style={{ marginTop: "16px", textAlign: "center" }}>
            {step === "password" ? (
              <button
                onClick={() => { setStep("email"); setPassword(""); }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "13px",
                  color: "#9ca3af",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Use a different email
              </button>
            ) : (
              <p style={{ fontSize: "13px", color: "#9ca3af", margin: 0 }}>
                Don't have an account?{" "}
                <button style={{ background: "none", border: "none", cursor: "pointer", color: "#6ec792", fontWeight: 600, fontSize: "13px", padding: 0 }}>
                  Sign up free
                </button>
              </p>
            )}
          </div>

          {/* Divider + trust */}
          <div style={{ marginTop: "22px", paddingTop: "18px", borderTop: "1px solid #f3f4f6", display: "flex", justifyContent: "center", alignItems: "center", gap: "14px" }}>
            {[
              { icon: "🔒", text: "TLS encrypted" },
              { icon: "✓", text: "SOC 2 Type II" },
            ].map(item => (
              <div key={item.text} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "10px" }}>{item.icon}</span>
                <span style={{ fontSize: "11px", color: "#b0b7c3" }}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right — hero (wider at 55%) */}
      <div
        style={{
          flex: "0 0 55%",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          overflow: "hidden",
          background: "#1b2632",
          padding: "56px 60px",
        }}
      >
        {/* Primary glow — top right */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse 75% 60% at 90% 10%, rgba(110,199,146,0.18) 0%, transparent 55%)",
          }}
        />
        {/* Secondary glow — bottom left */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse 55% 45% at 5% 90%, rgba(56,135,105,0.12) 0%, transparent 55%)",
          }}
        />
        {/* Grid */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)",
            backgroundSize: "52px 52px",
          }}
        />

        <div style={{ position: "relative", maxWidth: "420px" }}>
          {/* Badge */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              borderRadius: "100px",
              border: "1px solid rgba(110,199,146,0.25)",
              background: "rgba(110,199,146,0.08)",
              padding: "5px 13px",
              marginBottom: "30px",
            }}
          >
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ec792", boxShadow: "0 0 6px rgba(110,199,146,0.6)" }} />
            <span style={{ fontSize: "10.5px", fontFamily: "monospace", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd6ad" }}>
              400+ forms · proven at scale
            </span>
          </div>

          <h2
            style={{
              fontSize: "34px",
              fontWeight: 700,
              lineHeight: 1.22,
              letterSpacing: "-0.7px",
              color: "#fff",
              margin: "0 0 18px",
            }}
          >
            Every PDF you already have —{" "}
            <span style={{ color: "#6ec792" }}>
              digital, branded, and audit-ready.
            </span>
          </h2>

          <p style={{ fontSize: "15px", lineHeight: 1.65, color: "rgba(255,255,255,0.52)", margin: "0 0 44px" }}>
            Convert existing forms with faithful round-trip fidelity, or build new ones from scratch. No rip-and-replace.
          </p>

          {/* Stats */}
          <div style={{ display: "flex", gap: "36px", marginBottom: "40px" }}>
            {[
              { value: "98.6%", label: "extraction accuracy" },
              { value: "6 min", label: "avg. PDF → live form" },
            ].map(stat => (
              <div key={stat.label}>
                <div style={{ fontSize: "30px", fontWeight: 700, color: "#fff", letterSpacing: "-0.7px", lineHeight: 1 }}>
                  {stat.value}
                </div>
                <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.42)", marginTop: "5px" }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {/* Testimonial — elevated */}
          <div
            style={{
              borderRadius: "16px",
              border: "1px solid rgba(255,255,255,0.09)",
              background: "linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.025) 100%)",
              padding: "22px 24px",
              backdropFilter: "blur(12px)",
            }}
          >
            {/* Quote mark */}
            <div style={{ fontSize: "28px", lineHeight: 1, color: "rgba(110,199,146,0.35)", marginBottom: "8px", fontFamily: "Georgia, serif" }}>
              "
            </div>
            <p style={{ fontSize: "13.5px", lineHeight: 1.65, color: "rgba(255,255,255,0.7)", margin: "0 0 14px" }}>
              FormAI cut our compliance form update cycle from 3 weeks to 2 days. The round-trip accuracy is exceptional.
            </p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div
                  style={{
                    width: "30px",
                    height: "30px",
                    borderRadius: "50%",
                    background: "linear-gradient(135deg, rgba(110,199,146,0.3) 0%, rgba(79,178,123,0.2) 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "#6ec792",
                    flexShrink: 0,
                  }}
                >
                  SR
                </div>
                <div>
                  <div style={{ fontSize: "12.5px", fontWeight: 600, color: "rgba(255,255,255,0.82)" }}>Sarah R.</div>
                  <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.37)" }}>Head of Compliance, FinCorp</div>
                </div>
              </div>
              {/* Stars */}
              <div style={{ display: "flex", gap: "2px" }}>
                {[...Array(5)].map((_, i) => (
                  <svg key={i} width="12" height="12" viewBox="0 0 12 12" fill="#6ec792">
                    <path d="M6 1l1.4 2.8L10.5 4l-2.25 2.2.53 3.1L6 7.75l-2.78 1.55.53-3.1L1.5 4l3.1-.2L6 1z" />
                  </svg>
                ))}
              </div>
            </div>
          </div>

          {/* Company logos row */}
          <div style={{ marginTop: "28px", display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.3)", whiteSpace: "nowrap" }}>Trusted by teams at</span>
            <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
              {["FinCorp", "Axiom", "DataGrid"].map(name => (
                <span key={name} style={{ fontSize: "12px", fontWeight: 600, color: "rgba(255,255,255,0.28)", letterSpacing: "0.02em" }}>
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
