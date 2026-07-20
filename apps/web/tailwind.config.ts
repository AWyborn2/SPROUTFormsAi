import type { Config } from 'tailwindcss';
import preset from '@formai/ui/tailwind-preset';

export default {
  presets: [preset],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // Scan the UI package so its Tailwind classes are generated.
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
} satisfies Config;
