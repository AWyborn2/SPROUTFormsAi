import type { Config } from 'tailwindcss';

/**
 * FormAI Tailwind preset. Every scale references a CSS variable from the token
 * layer (`@formai/ui/tokens.css`) so utilities and tokens cannot drift — there
 * are no hardcoded hex values here.
 */
const preset: Omit<Config, 'content'> = {
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brand: {
          slate: 'var(--brand-slate)',
          sage: 'var(--brand-sage)',
          ink: 'var(--brand-ink)',
          green: 'var(--brand-green)',
        },
        surface: {
          page: 'var(--surface-page)',
          card: 'var(--surface-card)',
          sunken: 'var(--surface-sunken)',
          hover: 'var(--surface-hover)',
          inverse: 'var(--surface-inverse)',
          'accent-soft': 'var(--surface-accent-soft)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
          disabled: 'var(--text-disabled)',
          inverse: 'var(--text-inverse)',
          link: 'var(--text-link)',
          accent: 'var(--text-accent)',
        },
        border: {
          subtle: 'var(--border-subtle)',
          DEFAULT: 'var(--border-default)',
          strong: 'var(--border-strong)',
          accent: 'var(--border-accent)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          active: 'var(--accent-active)',
          contrast: 'var(--accent-contrast)',
        },
        solid: {
          DEFAULT: 'var(--solid)',
          hover: 'var(--solid-hover)',
          active: 'var(--solid-active)',
          contrast: 'var(--solid-contrast)',
        },
        success: 'var(--success)',
        'success-soft': 'var(--success-soft)',
        'success-text': 'var(--success-text)',
        warning: 'var(--warning)',
        'warning-soft': 'var(--warning-soft)',
        'warning-text': 'var(--warning-text)',
        danger: 'var(--danger)',
        'danger-soft': 'var(--danger-soft)',
        'danger-text': 'var(--danger-text)',
        info: 'var(--info)',
        'info-soft': 'var(--info-soft)',
        'info-text': 'var(--info-text)',
      },
      fontFamily: {
        heading: 'var(--font-heading)',
        body: 'var(--font-body)',
        ui: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        focus: 'var(--shadow-focus)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        entrance: 'var(--ease-entrance)',
        exit: 'var(--ease-exit)',
      },
      transitionDuration: {
        fast: '140ms',
        base: '220ms',
        slow: '340ms',
      },
    },
  },
  plugins: [],
};

export default preset;
