import { Badge, Card, Icon } from '@formai/ui';
import type { ScreenDef } from '../lib/screens.js';

/**
 * Phase-0 placeholder. Each screen resolves and renders its identity so the
 * shell, routing, theming, and keyboard layer are all exercisable now. Feature
 * phases replace these with the real screens.
 */
export function ScreenPlaceholder({ screen }: { screen: ScreenDef }) {
  return (
    <div className="fai-fade mx-auto max-w-3xl px-6 py-10">
      <Card padding="lg">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-lg bg-surface-accent-soft text-text-accent">
            <Icon name={screen.icon} size={22} />
          </span>
          <div>
            <div className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
              {screen.group}
            </div>
            <h2 className="text-xl">{screen.label}</h2>
          </div>
        </div>
        <p className="font-body text-sm text-text-secondary">
          Placeholder screen. The shell, routing, theme toggle, and keyboard layer
          (⌘K palette, “?” shortcuts) are live — this view is replaced with the real
          implementation in its feature phase.
        </p>
        <div className="mt-4">
          <Badge variant="accent" dot>
            Phase 0 scaffold
          </Badge>
        </div>
      </Card>
    </div>
  );
}
