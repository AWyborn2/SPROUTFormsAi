import { useState } from "react";

function BrandMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
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

function ArrowRight({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
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

export function SplitA() {
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

  const inputBase: React.CSSProperties = {
    width: "100%",
    height: "44px",
    padding: "0 14px",
    borderRadius: "10px",
    border: "1.5px solid #e5e7eb",
    background: "#f9fafb",
    fontSize: "14px",
    color: "#111827",
    outline: "none",
    transition: "border-color 0.15s, box-shadow 0.15s, background 0.15s",
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex" }}>
      {/* Left — form */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: "48px 40px",
          background: "#f4f5f7",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "348px",
            background: "#fff",
            borderRadius: "20px",
            padding: "36px 32px 32px",
            border: "1px solid rgba(0,0,0,0.055)",
            boxShadow:
              "0 1px 2px rgba(0,0,0,0.04), 0 4px 8px -2px rgba(0,0,0,0.07), 0 12px 32px -6px rgba(0,0,0,0.10)",
          }}
        >
          {/* Logo + progress */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <BrandMark />
              <span style={{ fontSize: "17px", fontWeight: 700, letterSpacing: "-0.3px", color: "#111827" }}>
                FormAI
              </span>
            </div>
            {/* Step indicator */}
            <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
              <div
                style={{
                  width: "20px",
                  height: "4px",
                  borderRadius: "2px",
                  background: "#6ec792",
                  transition: "background 0.2s",
                }}
              />
              <div
                style={{
                  width: "20px",
                  height: "4px",
                  borderRadius: "2px",
                  background: step === "password" ? "#6ec792" : "#e5e7eb",
                  transition: "background 0.2s",
                }}
              />
            </div>
          </div>

          {/* Heading */}
          <div style={{ marginBottom: "24px" }}>
            <h1 style={{ fontSize: "22px", fontWeight: 700, letterSpacing: "-0.4px", color: "#0f172a", margin: "0 0 5px" }}>
              {step === "email" ? "Welcome back" : "Enter your password"}
            </h1>
            <p style={{ fontSize: "13.5px", color: "#6b7280", margin: 0, lineHeight: 1.5 }}>
              {step === "email"
                ? "Sign in to your FormAI workspace."
                : (
                  <>Signing in as <span style={{ color: "#374151", fontWeight: 500 }}>{email}</span></>
                )}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            {step === "email" ? (
              <div style={{ marginBottom: "14px" }}>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#374151", marginBottom: "7px" }}>
                  Email address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoFocus
                  style={inputBase}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = "#6ec792";
                    e.currentTarget.style.background = "#fff";
                    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(110,199,146,0.13)";
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = "#e5e7eb";
                    e.currentTarget.style.background = "#f9fafb";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                />
              </div>
            ) : (
              <div style={{ marginBottom: "14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "7px" }}>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151" }}>Password</label>
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
                  style={inputBase}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = "#6ec792";
                    e.currentTarget.style.background = "#fff";
                    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(110,199,146,0.13)";
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = "#e5e7eb";
                    e.currentTarget.style.background = "#f9fafb";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                />
              </div>
            )}

            {/* Always green button */}
            <button
              type="submit"
              disabled={loading || (step === "email" ? !email : !password)}
              style={{
                width: "100%",
                height: "44px",
                borderRadius: "10px",
                background: "linear-gradient(135deg, #6ec792 0%, #4fb27b 100%)",
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
                transition: "opacity 0.15s, transform 0.1s",
                boxShadow: "0 1px 2px rgba(62,207,142,0.2), 0 4px 12px rgba(62,207,142,0.18)",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; }}
            >
              {loading ? <Spinner /> : <>{step === "email" ? "Continue" : "Sign in"} <ArrowRight /></>}
            </button>
          </form>

          {/* Footer */}
          <div
            style={{
              marginTop: "18px",
              display: "flex",
              alignItems: "center",
              justifyContent: step === "password" ? "center" : "center",
            }}
          >
            {step === "password" ? (
              <button
                onClick={() => { setStep("email"); setPassword(""); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "13px",
                  color: "#9ca3af",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  fontWeight: 500,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M9 11L5 7l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Back
              </button>
            ) : (
              <p style={{ fontSize: "13px", color: "#9ca3af", margin: 0 }}>
                No account?{" "}
                <button
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#6ec792",
                    fontWeight: 600,
                    fontSize: "13px",
                    padding: 0,
                  }}
                >
                  Create one
                </button>
              </p>
            )}
          </div>

          {/* Trust row */}
          <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid #f3f4f6", display: "flex", justifyContent: "center", alignItems: "center", gap: "6px" }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1L1.5 3v3c0 2.485 1.955 4.8 4.5 5.5C8.545 10.8 10.5 8.485 10.5 6V3L6 1z" stroke="#9ca3af" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: "11.5px", color: "#b0b7c3", letterSpacing: "0.01em" }}>
              TLS encrypted · SOC 2 compliant
            </span>
          </div>
        </div>
      </div>

      {/* Right — hero */}
      <div
        style={{
          flex: 1,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          overflow: "hidden",
          background: "#1e2a32",
          padding: "56px",
        }}
      >
        {/* Multi-layer glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse 70% 55% at 85% 15%, rgba(110,199,146,0.16) 0%, transparent 55%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse 50% 40% at 10% 85%, rgba(78,160,120,0.09) 0%, transparent 50%)",
          }}
        />
        {/* Grid */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.033) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.033) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />

        <div style={{ position: "relative", maxWidth: "390px" }}>
          {/* Badge */}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              borderRadius: "100px",
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(255,255,255,0.06)",
              padding: "5px 12px",
              marginBottom: "28px",
            }}
          >
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ec792" }} />
            <span style={{ fontSize: "10.5px", fontFamily: "monospace", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd6ad" }}>
              400+ forms · proven at scale
            </span>
          </div>

          <h2
            style={{
              fontSize: "30px",
              fontWeight: 700,
              lineHeight: 1.25,
              letterSpacing: "-0.5px",
              color: "#fff",
              margin: "0 0 16px",
            }}
          >
            Every PDF you already have —{" "}
            <span style={{ color: "#6ec792" }}>digital, branded, and audit-ready.</span>
          </h2>

          <p style={{ fontSize: "14.5px", lineHeight: 1.65, color: "rgba(255,255,255,0.55)", margin: "0 0 40px" }}>
            Convert existing forms with faithful round-trip fidelity, or build new ones from scratch.
          </p>

          {/* Stats — with divider */}
          <div
            style={{
              display: "flex",
              gap: "0",
              marginBottom: "36px",
              padding: "20px 0",
              borderTop: "1px solid rgba(255,255,255,0.08)",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {[
              { value: "98.6%", label: "extraction accuracy" },
              { value: "6 min", label: "avg. PDF → live form" },
            ].map((stat, i) => (
              <div key={stat.label} style={{ flex: 1, paddingLeft: i > 0 ? "28px" : 0, borderLeft: i > 0 ? "1px solid rgba(255,255,255,0.08)" : "none", marginLeft: i > 0 ? "28px" : 0 }}>
                <div style={{ fontSize: "26px", fontWeight: 700, color: "#fff", letterSpacing: "-0.5px", lineHeight: 1 }}>
                  {stat.value}
                </div>
                <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.45)", marginTop: "4px" }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>

          {/* Testimonial */}
          <div
            style={{
              borderRadius: "14px",
              border: "1px solid rgba(255,255,255,0.09)",
              background: "rgba(255,255,255,0.04)",
              padding: "18px 20px",
              backdropFilter: "blur(8px)",
            }}
          >
            {/* Stars */}
            <div style={{ display: "flex", gap: "2px", marginBottom: "10px" }}>
              {[...Array(5)].map((_, i) => (
                <svg key={i} width="12" height="12" viewBox="0 0 12 12" fill="#6ec792">
                  <path d="M6 1l1.4 2.8L10.5 4l-2.25 2.2.53 3.1L6 7.75l-2.78 1.55.53-3.1L1.5 4l3.1-.2L6 1z" />
                </svg>
              ))}
            </div>
            <p style={{ fontSize: "13px", lineHeight: 1.6, color: "rgba(255,255,255,0.68)", margin: "0 0 12px", fontStyle: "italic" }}>
              "FormAI cut our compliance form update cycle from 3 weeks to 2 days."
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  background: "rgba(110,199,146,0.2)",
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
                <div style={{ fontSize: "12px", fontWeight: 600, color: "rgba(255,255,255,0.8)" }}>Sarah R.</div>
                <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.38)" }}>Head of Compliance, FinCorp</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
