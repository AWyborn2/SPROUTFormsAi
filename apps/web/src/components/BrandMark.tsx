/**
 * The FormAI brand mark — a checkmark-and-form-field motif. `light` renders the
 * solid slate tile for on-white surfaces; `dark` renders the translucent tile
 * used on the slate sidebar.
 */
export function BrandMark({ variant = 'light', size = 30 }: { variant?: 'light' | 'dark'; size?: number }) {
  const tile = variant === 'light' ? '#253439' : 'rgba(255,255,255,0.07)';
  const lines = variant === 'light' ? '#7c8b8d' : '#9fb0b0';
  const stroke = variant === 'dark' ? 'rgba(255,255,255,0.14)' : 'none';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect
        x={0.75}
        y={0.75}
        width={30.5}
        height={30.5}
        rx={8}
        fill={tile}
        stroke={stroke}
        strokeWidth={stroke === 'none' ? 0 : 1.5}
      />
      <rect x={7} y={8.5} width={13} height={2.6} rx={1.3} fill={lines} />
      <rect x={7} y={14} width={9} height={2.6} rx={1.3} fill={lines} />
      <path
        d="M12.4 21.2 L15.6 24.4 L24.2 14.6"
        stroke="#6ec792"
        strokeWidth={3.1}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
