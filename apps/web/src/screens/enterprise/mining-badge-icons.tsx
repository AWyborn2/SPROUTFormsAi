import type { ReactNode } from 'react';

type IconProps = { size?: number; color?: string };

function svg(size: number, color: string, children: ReactNode) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function sv(size: number, color: string, d: string, extra?: ReactNode) {
  return svg(size, color, <><path d={d} />{extra}</>);
}

/* ── Equipment icons (matching reference sheet) ────────────────────── */

function HaulTruck({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M8 4h11l2 2v5H7V7.5L8 4z" />
    <path d="M3 8.5h4V11H3z" />
    <rect x="3.5" y="9" width="2" height="1.5" rx="0.5" strokeWidth={1} />
    <line x1="3" y1="11" x2="21" y2="11" />
    <path d="M3 11.5v2.5" />
    <path d="M21 11.5v2.5" />
    <circle cx="7" cy="16.5" r="3" />
    <circle cx="7" cy="16.5" r="1" />
    <circle cx="17.5" cy="16.5" r="3" />
    <circle cx="17.5" cy="16.5" r="1" />
  </>);
}

function TrackDozer({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M2 10h2v7" />
    <path d="M2 11.5h2.5" />
    <rect x="7" y="6" width="11" height="7" rx="1" />
    <rect x="9" y="7.5" width="5" height="3.5" rx="0.5" strokeWidth={1} />
    <line x1="16" y1="6" x2="16" y2="3.5" />
    <path d="M5 13h15" />
    <rect x="5" y="13" width="15" height="6" rx="3" />
    <circle cx="8" cy="16" r="1.5" strokeWidth={1} />
    <circle cx="17" cy="16" r="1.5" strokeWidth={1} />
    <line x1="10" y1="16" x2="15" y2="16" strokeWidth={1} />
  </>);
}

function Excavator({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect x="2" y="14" width="11" height="5" rx="2.5" />
    <circle cx="5" cy="16.5" r="1.5" strokeWidth={1} />
    <circle cx="10" cy="16.5" r="1.5" strokeWidth={1} />
    <line x1="6.5" y1="16.5" x2="8.5" y2="16.5" strokeWidth={1} />
    <rect x="4" y="10" width="7" height="4" rx="1" />
    <rect x="5.5" y="11" width="3" height="2" rx="0.5" strokeWidth={1} />
    <path d="M9 10L12 5" />
    <path d="M12 5L18 3" />
    <path d="M18 3L21 7L19 8" />
    <path d="M19 8L17 7" strokeWidth={1.2} />
  </>);
}

function Float({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect x="1" y="6" width="5" height="5" rx="1" />
    <rect x="1.5" y="6.5" width="2.5" height="2.5" rx="0.5" strokeWidth={1} />
    <path d="M6 9h15v4H6z" />
    <path d="M21 13l2 3" />
    <path d="M21 16h2" />
    <line x1="1" y1="11" x2="21" y2="11" />
    <line x1="6" y1="13" x2="21" y2="13" />
    <circle cx="4" cy="15" r="2" />
    <circle cx="4" cy="15" r="0.7" strokeWidth={1} />
    <circle cx="13" cy="15" r="2" />
    <circle cx="13" cy="15" r="0.7" strokeWidth={1} />
    <circle cx="18" cy="15" r="2" />
    <circle cx="18" cy="15" r="0.7" strokeWidth={1} />
  </>);
}

function SkidSteer({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M3 11h4V7l2-2h6l2 2v4h-1" />
    <rect x="7" y="5" width="8" height="9" rx="1" />
    <line x1="9" y1="7" x2="13" y2="7" strokeWidth={1} />
    <line x1="9" y1="9" x2="13" y2="9" strokeWidth={1} />
    <line x1="9" y1="11" x2="13" y2="11" strokeWidth={1} />
    <path d="M3 11v3h2" />
    <path d="M3 12h1.5" />
    <circle cx="7" cy="17" r="3" />
    <circle cx="7" cy="17" r="1.2" strokeWidth={1} />
    <circle cx="17" cy="17" r="3" />
    <circle cx="17" cy="17" r="1.2" strokeWidth={1} />
    <line x1="10" y1="14" x2="14" y2="14" />
  </>);
}

function ArticulatedDumpTruck({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M2 7h6v5H2z" />
    <rect x="2.5" y="7.5" width="3" height="2.5" rx="0.5" strokeWidth={1} />
    <path d="M8 7v5" />
    <path d="M8 5h12l2 2v5H8z" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <circle cx="5" cy="16" r="2.5" />
    <circle cx="5" cy="16" r="0.8" strokeWidth={1} />
    <circle cx="13" cy="16" r="2.5" />
    <circle cx="13" cy="16" r="0.8" strokeWidth={1} />
    <circle cx="19" cy="16" r="2.5" />
    <circle cx="19" cy="16" r="0.8" strokeWidth={1} />
  </>);
}

function Grader({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M14 5h6v7h-6z" />
    <rect x="15" y="6" width="3" height="3" rx="0.5" strokeWidth={1} />
    <line x1="18" y1="5" x2="18" y2="3" />
    <path d="M3 12h17" />
    <path d="M5 15L3 12h11" />
    <path d="M7 15l5-3" strokeWidth={2} />
    <circle cx="4" cy="17" r="2.5" />
    <circle cx="4" cy="17" r="0.8" strokeWidth={1} />
    <circle cx="17" cy="15" r="2.5" />
    <circle cx="17" cy="15" r="0.8" strokeWidth={1} />
    <circle cx="21" cy="15" r="2" />
    <circle cx="21" cy="15" r="0.7" strokeWidth={1} />
    <line x1="3" y1="12" x2="4" y2="14.5" />
  </>);
}

function FrontLoader({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M2 8h8l1-2h-7z" />
    <path d="M2 8v2h9" />
    <path d="M9 6l3-1" />
    <path d="M11 10l1-5" />
    <rect x="12" y="5" width="7" height="7" rx="1" />
    <rect x="13" y="6" width="4" height="3.5" rx="0.5" strokeWidth={1} />
    <line x1="12" y1="12" x2="19" y2="12" />
    <circle cx="7" cy="17" r="3.5" />
    <circle cx="7" cy="17" r="1.2" strokeWidth={1} />
    <circle cx="18" cy="16" r="3" />
    <circle cx="18" cy="16" r="1" strokeWidth={1} />
    <path d="M3.5 12v1.5" />
    <path d="M19 12v1" />
  </>);
}

function MineVehicle({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M2 10l2-4h6l2 2h8v5H2z" />
    <rect x="3" y="7" width="5" height="3" rx="0.5" strokeWidth={1} />
    <line x1="12" y1="8" x2="12" y2="13" />
    <line x1="2" y1="13" x2="20" y2="13" />
    <circle cx="6" cy="16" r="2.5" />
    <circle cx="6" cy="16" r="0.8" strokeWidth={1} />
    <circle cx="17" cy="16" r="2.5" />
    <circle cx="17" cy="16" r="0.8" strokeWidth={1} />
    <line x1="20" y1="10" x2="22" y2="10" />
    <line x1="20" y1="12" x2="22" y2="12" />
  </>);
}

function Scraper({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect x="1" y="6" width="5" height="4" rx="1" />
    <rect x="1.5" y="6.5" width="2.5" height="2" rx="0.3" strokeWidth={1} />
    <path d="M6 8h10" />
    <path d="M6 10h10v3H6z" />
    <path d="M8 13v2h6v-2" strokeWidth={1} />
    <path d="M16 6h4v7h-4z" />
    <circle cx="4" cy="14" r="2.5" />
    <circle cx="4" cy="14" r="0.8" strokeWidth={1} />
    <circle cx="18" cy="16" r="3.5" />
    <circle cx="18" cy="16" r="1.2" strokeWidth={1} />
  </>);
}

function Roller({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <circle cx="7" cy="15" r="5" />
    <circle cx="7" cy="15" r="3" strokeWidth={1} />
    <circle cx="7" cy="15" r="1" strokeWidth={1} />
    <rect x="11" y="6" width="7" height="6" rx="1" />
    <rect x="12" y="7" width="4" height="3" rx="0.5" strokeWidth={1} />
    <path d="M11 12h7v2h-7z" />
    <line x1="12" y1="10" x2="10" y2="12" />
    <circle cx="18" cy="17" r="3" />
    <circle cx="18" cy="17" r="1" strokeWidth={1} />
    <line x1="18" y1="14" x2="18" y2="12" />
  </>);
}

function Crane({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect x="2" y="12" width="12" height="5" rx="1" />
    <rect x="3" y="13" width="5" height="3" rx="0.5" strokeWidth={1} />
    <path d="M8 12L18 3" />
    <path d="M18 3l2 1" />
    <path d="M10 12l10-8" strokeWidth={1} />
    <line x1="19" y1="4" x2="19" y2="7" />
    <circle cx="5" cy="20" r="2.5" />
    <circle cx="5" cy="20" r="0.8" strokeWidth={1} />
    <circle cx="11" cy="20" r="2.5" />
    <circle cx="11" cy="20" r="0.8" strokeWidth={1} />
    <path d="M2 17v0.5" />
    <path d="M14 17v0.5" />
    <line x1="14" y1="14" x2="16" y2="14" />
    <line x1="14" y1="16" x2="16" y2="16" />
  </>);
}

function FuelLubeTruck({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect x="1" y="7" width="5" height="5" rx="1" />
    <rect x="1.5" y="7.5" width="2.5" height="2.5" rx="0.3" strokeWidth={1} />
    <line x1="6" y1="12" x2="21" y2="12" />
    <ellipse cx="12" cy="9" rx="5" ry="3" />
    <line x1="7" y1="9" x2="17" y2="9" strokeWidth={1} />
    <ellipse cx="20" cy="9.5" rx="1.5" ry="2.5" />
    <path d="M18 7l-1-2h2l1 2" strokeWidth={1} />
    <circle cx="5" cy="16" r="2.5" />
    <circle cx="5" cy="16" r="0.8" strokeWidth={1} />
    <circle cx="14" cy="16" r="2.5" />
    <circle cx="14" cy="16" r="0.8" strokeWidth={1} />
    <circle cx="20" cy="16" r="2" />
    <circle cx="20" cy="16" r="0.7" strokeWidth={1} />
  </>);
}

function HardHat({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z" />
    <path d="M10 15V6.5a3.5 3.5 0 0 1 7 0v0a2 2 0 0 1 2 2V15" />
    <path d="M5 15v-4a2 2 0 0 1 2-2h0v-2a5 5 0 0 1 5-5" />
  </>);
}

/* ── Non-equipment / utility icons ─────────────────────────────────── */

function Leaf({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 20 2 20 2s-1.9 6.5-3.9 12.1A7 7 0 0 1 11 20z', <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />);
}

function Shield({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z');
}

function AlertTriangle({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>);
}

function Beaker({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M4.5 3h15" />
    <path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3" />
    <path d="M6 14h12" />
  </>);
}

function Car({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
    <circle cx="7" cy="17" r="2" />
    <path d="M9 17h6" />
    <circle cx="17" cy="17" r="2" />
  </>);
}

function Clipboard({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 11h4" />
    <path d="M12 16h4" />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </>);
}

function Pickaxe({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912" />
    <path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393" />
    <path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" />
    <path d="M19.686 8.314a12.5 12.5 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.318" />
  </>);
}

function Cone({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M9.3 6.2a4.55 4.55 0 0 0 5.4 0" />
    <path d="M7.9 10.7c.9.8 2.4 1.3 4.1 1.3s3.2-.5 4.1-1.3" />
    <path d="M13.9 3.5a1.93 1.93 0 0 0-3.8-.1l-3 10c-.1.2-.1.4-.1.6 0 1.7 2.2 3 5 3s5-1.3 5-3c0-.2 0-.4-.1-.5z" />
    <path d="M2 21h20" />
    <path d="m8 21 2.4-7.2" />
    <path d="m16 21-2.4-7.2" />
  </>);
}

function Forklift({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M5 11V5a2 2 0 0 1 2-2h3" />
    <path d="M14 3v8h3a2 2 0 0 1 2 2v3" />
    <circle cx="7" cy="18" r="2" />
    <path d="M5 18H3" />
    <circle cx="17" cy="18" r="2" />
    <path d="M15 18h-4a1 1 0 0 1-1-1v-6" />
    <path d="M19 18h2v-7" />
    <path d="M21 11h-5" />
  </>);
}

function FirstAid({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <line x1="12" y1="9" x2="12" y2="15" />
    <line x1="9" y1="12" x2="15" y2="12" />
  </>);
}

function Wrench({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z');
}

function Flame({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z');
}

function Globe({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </>);
}

function Radio({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
    <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" />
    <circle cx="12" cy="12" r="2" />
    <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" />
    <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
  </>);
}

function Eye({ size = 32, color = 'currentColor' }: IconProps) {
  return svg(size, color, <>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </>);
}

/* ── Keyword → icon map (most specific first) ──────────────────────── */

const KEYWORD_ICON: Array<[RegExp, (p: IconProps) => ReactNode]> = [
  // Equipment — specific machine types (order matters: specific before general)
  [/haul.?truck|rear.?dump|mining.?truck|cat.?7/i, HaulTruck],
  [/dozer|bull.?dozer|D\d{1,2}\b|track.?dozer/i, TrackDozer],
  [/grader|motor.?grader/i, Grader],
  [/skid.?steer|bobcat|compact.?loader/i, SkidSteer],
  [/front.?(?:end\s)?loader|wheel.?loader|(?:small|large)\s+loader/i, FrontLoader],
  [/scraper|elevating.?scraper/i, Scraper],
  [/roller|compactor|vibrat.?roll/i, Roller],
  [/articulated.?(?:dump|haul)|ADT\b/i, ArticulatedDumpTruck],
  [/float|low.?loader|low.?boy|trailer/i, Float],
  [/fuel.?(?:and|&)?\s*lube|service.?truck|fuel.?truck|lube.?truck/i, FuelLubeTruck],
  [/crane|mobile.?crane|franna|all.?terrain/i, Crane],
  [/excavat|digger/i, Excavator],
  [/forklift|telehandler|elevated|EWP/i, Forklift],
  // Equipment — broader categories
  [/truck|dump|water.?cart/i, HaulTruck],
  [/loader|backhoe/i, FrontLoader],
  [/driver|licence|license|car\b|vehicle|motor|ute\b|light.?vehicle/i, MineVehicle],
  // Non-equipment competencies
  [/induction|orient|onboard|induc/i, HardHat],
  [/chem|hazmat|chemical|dangerous.?goods|DG\b/i, Beaker],
  [/first.?aid|medic|CPR|resuscit/i, FirstAid],
  [/fire|hot.?work|welding|burn/i, Flame],
  [/environment|sustain|waste|spill/i, Globe],
  [/forest|hygiene|vegetation|tree|weed/i, Leaf],
  [/barricade|barrier|traffic|isolat/i, Cone],
  [/edge|void|height|fall|scaffold|harness/i, AlertTriangle],
  [/awareness|sme|competent|assess/i, Eye],
  [/radio|comms|communic/i, Radio],
  [/endorse|certif|form|contractor|permit/i, Clipboard],
  [/safe|risk|haz/i, Shield],
  [/maintenance|mechanic|repair|fitting/i, Wrench],
  [/mine|mining|underground|surface/i, Pickaxe],
];

export interface CustomBadgeIcon {
  iconUrl: string;
  keywords: string[];
  slug: string;
  displayName: string;
}

function matchCustomIcon(name: string, customs: CustomBadgeIcon[]): CustomBadgeIcon | undefined {
  const lower = name.toLowerCase();
  for (const icon of customs) {
    for (const kw of icon.keywords) {
      if (lower.includes(kw.toLowerCase())) return icon;
    }
  }
  for (const icon of customs) {
    if (lower.includes(icon.slug)) return icon;
  }
  return undefined;
}

export function miningBadgeIcon(
  name: string,
  size = 32,
  color = 'currentColor',
  customIcons?: CustomBadgeIcon[],
): ReactNode {
  if (customIcons?.length) {
    const custom = matchCustomIcon(name, customIcons);
    if (custom) {
      return (
        <img
          src={`/api${custom.iconUrl}`}
          alt={custom.displayName}
          width={size}
          height={size}
          style={{ objectFit: 'contain' }}
        />
      );
    }
  }
  for (const [re, Icon] of KEYWORD_ICON) {
    if (re.test(name)) return <Icon size={size} color={color} />;
  }
  return <Pickaxe size={size} color={color} />;
}
