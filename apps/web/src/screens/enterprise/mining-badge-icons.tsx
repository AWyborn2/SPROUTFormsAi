import type { ReactNode } from 'react';

type IconProps = { size?: number; color?: string };

function sv(size: number, color: string, d: string, extra?: ReactNode) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
      {extra}
    </svg>
  );
}

function HardHat({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z" />
      <path d="M10 15V6.5a3.5 3.5 0 0 1 7 0v0a2 2 0 0 1 2 2V15" />
      <path d="M5 15v-4a2 2 0 0 1 2-2h0v-2a5 5 0 0 1 5-5" />
    </svg>
  );
}

function Truck({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 13.52 9H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  );
}

function Excavator({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="16" width="10" height="5" rx="1" />
      <path d="M5 16V9a1 1 0 0 1 1-1h2" />
      <path d="M9 8l5-5 3 3-5 5" />
      <path d="M17 6l3 3" />
      <circle cx="5" cy="21" r="1" />
      <circle cx="9" cy="21" r="1" />
      <path d="M20 11v5a2 2 0 0 1-2 2h-6" />
    </svg>
  );
}

function Leaf({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 20 2 20 2s-1.9 6.5-3.9 12.1A7 7 0 0 1 11 20z', <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />);
}

function Shield({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z');
}

function AlertTriangle({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function Beaker({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 3h15" />
      <path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3" />
      <path d="M6 14h12" />
    </svg>
  );
}

function Car({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
      <circle cx="7" cy="17" r="2" />
      <path d="M9 17h6" />
      <circle cx="17" cy="17" r="2" />
    </svg>
  );
}

function Clipboard({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </svg>
  );
}

function Pickaxe({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912" />
      <path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393" />
      <path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" />
      <path d="M19.686 8.314a12.5 12.5 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.318" />
    </svg>
  );
}

function Cone({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.3 6.2a4.55 4.55 0 0 0 5.4 0" />
      <path d="M7.9 10.7c.9.8 2.4 1.3 4.1 1.3s3.2-.5 4.1-1.3" />
      <path d="M13.9 3.5a1.93 1.93 0 0 0-3.8-.1l-3 10c-.1.2-.1.4-.1.6 0 1.7 2.2 3 5 3s5-1.3 5-3c0-.2 0-.4-.1-.5z" />
      <path d="M2 21h20" />
      <path d="m8 21 2.4-7.2" />
      <path d="m16 21-2.4-7.2" />
    </svg>
  );
}

function Forklift({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 11V5a2 2 0 0 1 2-2h3" />
      <path d="M14 3v8h3a2 2 0 0 1 2 2v3" />
      <circle cx="7" cy="18" r="2" />
      <path d="M5 18H3" />
      <circle cx="17" cy="18" r="2" />
      <path d="M15 18h-4a1 1 0 0 1-1-1v-6" />
      <path d="M19 18h2v-7" />
      <path d="M21 11h-5" />
    </svg>
  );
}

function FirstAid({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <line x1="12" y1="9" x2="12" y2="15" />
      <line x1="9" y1="12" x2="15" y2="12" />
    </svg>
  );
}

function Wrench({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z');
}

function Flame({ size = 32, color = 'currentColor' }: IconProps) {
  return sv(size, color, 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z');
}

function Globe({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function Radio({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </svg>
  );
}

function Eye({ size = 32, color = 'currentColor' }: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

const KEYWORD_ICON: Array<[RegExp, (p: IconProps) => ReactNode]> = [
  [/scraper|grader|dozer|excavat|loader|backhoe|bobcat|skid.?steer/i, Excavator],
  [/truck|haul|dump|water.?cart|service.?road/i, Truck],
  [/driver|licence|license|car\b|vehicle|motor/i, Car],
  [/forklift|telehandler|crane|elevated|EWP/i, Forklift],
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

export function miningBadgeIcon(name: string, size = 32, color = 'currentColor'): ReactNode {
  for (const [re, Icon] of KEYWORD_ICON) {
    if (re.test(name)) return <Icon size={size} color={color} />;
  }
  return <Pickaxe size={size} color={color} />;
}
