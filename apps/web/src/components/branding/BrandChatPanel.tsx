import { useState } from 'react';
import { Icon } from '@formai/ui';
import type { FormBrandKit } from '@formai/shared';
import { ApiError } from '../../lib/data/api-client.js';
import { useEditFormBrandByChat } from '../../lib/data/hooks.js';
import type { BrandEditProposal } from '../../lib/data/types.js';

interface BrandChatPanelProps {
  /** The brand being edited. The server reads its stored kit as the baseline. */
  brandId: string;
  /** Applies the proposal to the working draft. Still unsaved after this. */
  onApply: (patch: FormBrandKit) => void;
  disabled?: boolean;
}

/**
 * "Make it navy and a bit tighter" — changing a brand by describing the change.
 *
 * Faster than eight controls, and closer to how the change is actually held in
 * mind: the author knows what they want before they know which token carries
 * it.
 *
 * APPLY IS A SEPARATE CLICK, and the proposal is shown before it. Not caution
 * for its own sake — the model is guessing at intent from one sentence, and a
 * guess that applied itself would leave the author reversing a change they
 * never asked for, in a settings panel with no undo.
 *
 * THE BASELINE IS THE SAVED BRAND, NOT THE UNSAVED DRAFT. The server reads the
 * stored kit, so a request made on top of unsaved edits is answered relative to
 * what was last saved. Said out loud below rather than hidden, because
 * "slightly rounder" resolving against the wrong starting point is invisible
 * until the preview looks wrong.
 */
export function BrandChatPanel({ brandId, onApply, disabled }: BrandChatPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<BrandEditProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const edit = useEditFormBrandByChat();

  function run() {
    const text = instruction.trim();
    if (!text) return;
    setError(null);
    setProposal(null);
    edit.mutate(
      { id: brandId, instruction: text },
      {
        onSuccess: setProposal,
        onError: (err) =>
          setError(
            err instanceof ApiError && err.status === 422
              ? 'Describing a change isn’t available on this workspace yet. The controls below still work.'
              : 'That didn’t work. Try describing the change differently, or use the controls below.',
          ),
      },
    );
  }

  const hasPatch = !!proposal && Object.keys(proposal.patch).length > 0;

  return (
    <div className="rounded-md border border-dashed border-border-strong p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="message-square" size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Describe a change</span>
      </div>
      <p className="mb-2.5 text-[12px] text-text-tertiary">
        &ldquo;Make it navy with tighter spacing.&rdquo; You&rsquo;ll see what it proposes before
        anything changes.
      </p>

      <div className="flex items-end gap-2">
        <input
          value={instruction}
          disabled={disabled || edit.isPending}
          aria-label="Describe a change to this brand"
          placeholder="Navy headings, square buttons…"
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
          }}
          className="h-9 min-w-0 flex-1 rounded-md border border-border-strong bg-surface-card px-2.5 font-ui text-[12.5px] text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus disabled:opacity-60"
        />
        <button
          type="button"
          onClick={run}
          disabled={disabled || edit.isPending || !instruction.trim()}
          className="fai-chip-btn h-9 flex-none rounded-md border border-border bg-surface-card px-3 text-[12.5px] font-semibold disabled:opacity-60"
        >
          {edit.isPending ? 'Thinking…' : 'Suggest'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <Icon name="info" size={13} className="mt-px flex-none" />
          {error}
        </p>
      )}

      {proposal && (
        <div className="mt-3 rounded-md border border-border-subtle bg-surface-sunken p-2.5">
          {proposal.summary && (
            <div className="mb-1.5 text-[12.5px] font-semibold">{proposal.summary}</div>
          )}

          {hasPatch ? (
            <>
              {/* The exact values, not just the sentence. A summary can sound
                  right over a patch that is not, and the swatch is the only
                  part of this an author can actually check at a glance. */}
              <div className="mb-2 flex flex-wrap gap-1.5">
                {Object.entries(flatten(proposal.patch)).map(([key, value]) => (
                  <span
                    key={key}
                    className="flex items-center gap-1 rounded border border-border bg-surface-card px-1.5 py-0.5 text-[11px] text-text-secondary"
                  >
                    {isHex(value) && (
                      <span
                        className="h-3 w-3 flex-none rounded-sm border border-border"
                        style={{ background: value }}
                      />
                    )}
                    {key}: {value}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  onApply(proposal.patch);
                  setProposal(null);
                  setInstruction('');
                }}
                className="fai-chip-btn rounded-md border border-border-accent bg-surface-card px-2.5 py-1 text-[12px] font-semibold text-accent"
              >
                Apply
              </button>
            </>
          ) : (
            <div className="text-[12px] text-text-tertiary">Nothing to apply from that one.</div>
          )}

          {proposal.notes.map((note) => (
            <p key={note} className="mt-1.5 text-[11.5px] text-text-tertiary">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function isHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

/** `{theme: {radius: 20}}` → `{'theme.radius': '20'}`, for display only. */
function flatten(patch: FormBrandKit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'theme' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) out[`theme.${k}`] = String(v);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}
