import { useState } from 'react';
import { Button, Icon, Input, Select, Switch, useToast } from '@formai/ui';
import { useForms } from '../../lib/data/hooks.js';
import {
  useAddRule,
  useCompetencies,
  useCompetencyRules,
  useRemoveRule,
  useToggleRule,
} from '../../lib/data/hooks.js';

/**
 * Competency gating — the rule builder (which competency unlocks which form
 * section) plus a "how fillers see it" locked-section preview. Rules drive the
 * gated rendering in the external fill view.
 */
export function CompetencyScreen() {
  const { toast } = useToast();
  const { data: forms = [] } = useForms();
  const { data: competencies = [] } = useCompetencies();
  const { data: rules = [] } = useCompetencyRules();
  const addRule = useAddRule();
  const toggleRule = useToggleRule();
  const removeRule = useRemoveRule();

  const [ruleForm, setRuleForm] = useState('f3');
  const [ruleComp, setRuleComp] = useState('c1');
  const [ruleSection, setRuleSection] = useState('');

  // Preview: first enabled rule, else first rule, else a placeholder.
  const previewRule = rules.find((r) => r.enabled) ?? rules[0];
  const exSection = previewRule?.section ?? 'a gated section';
  const exComp = previewRule?.competency ?? 'a competency';

  function onAdd() {
    if (!ruleSection.trim()) {
      toast({ variant: 'warning', message: 'Enter the form section this competency should unlock.' });
      return;
    }
    const comp = competencies.find((c) => c.id === ruleComp);
    addRule.mutate(
      { formId: ruleForm, competencyId: ruleComp, section: ruleSection.trim() },
      {
        onSuccess: (rule) => {
          if (!rule) return;
          toast({ variant: 'success', message: `${comp?.name ?? 'Competency'} now unlocks “${rule.section}”.` });
          setRuleSection('');
        },
      },
    );
  }

  return (
    <div className="fai-rise mx-auto grid max-w-[1040px] grid-cols-1 items-start gap-5 p-[30px_28px_60px] md:grid-cols-[minmax(0,290px)_minmax(0,1fr)]">
      {/* Left: competencies + filler preview */}
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="border-b border-border-subtle px-[18px] py-4">
            <div className="font-heading text-[15px] font-bold">Competencies</div>
            <div className="mt-0.5 text-xs text-text-tertiary">Held records synced from your LMS</div>
          </div>
          {competencies.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 border-b border-border-subtle px-[18px] py-[13px] last:border-b-0"
            >
              <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: c.color }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{c.name}</div>
                <div className="font-mono text-[11px] text-text-tertiary">{c.code}</div>
              </div>
              <span className="font-heading text-sm font-bold">{c.holders}</span>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-border-accent bg-surface-accent-soft p-[16px_18px]">
          <div className="mb-2.5 flex items-center gap-[7px]">
            <Icon name="lock" size={14} className="text-accent" />
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-accent">
              How fillers see it
            </span>
          </div>
          <div className="rounded-md border border-border bg-white p-[13px] opacity-95">
            <div className="flex items-center gap-2 opacity-60 grayscale">
              <Icon name="lock" size={14} />
              <span className="text-[12.5px] font-semibold text-[#1a2224]">{exSection}</span>
            </div>
            <div className="mt-2 h-[30px] rounded-md border border-dashed border-border-strong bg-surface-sunken" />
            <div className="mt-2 flex items-center gap-[5px] text-[11px] text-warning-text">
              <Icon name="shield-alert" size={12} />
              Unlocks with {exComp}
            </div>
          </div>
        </div>
      </div>

      {/* Right: rule builder + active rules */}
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs">
          <div className="mb-1 font-heading text-[15px] font-bold">New gating rule</div>
          <p className="mb-4 text-[12.5px] text-text-tertiary">
            Unlock a form section only for people who hold the right competency.
          </p>
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="Form"
              value={ruleForm}
              onChange={(e) => setRuleForm(e.target.value)}
              options={forms.map((f) => ({ value: f.id, label: f.name }))}
            />
            <Select
              label="Required competency"
              value={ruleComp}
              onChange={(e) => setRuleComp(e.target.value)}
              options={competencies.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
          <div className="flex items-end gap-2.5">
            <div className="flex-1">
              <Input
                label="Section to gate"
                placeholder="e.g. Roof access items"
                value={ruleSection}
                onChange={(e) => setRuleSection(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onAdd();
                }}
              />
            </div>
            <Button leadingIcon="plus" onClick={onAdd}>
              Add rule
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="border-b border-border-subtle px-5 py-4 font-heading text-[15px] font-bold">
            Active rules · {rules.length}
          </div>
          {rules.map((r) => {
            const dot = competencies.find((c) => c.id === r.competencyId)?.color ?? 'var(--accent)';
            return (
              <div
                key={r.id}
                className="flex items-center gap-[14px] border-b border-border-subtle px-5 py-3.5 last:border-b-0"
              >
                <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: dot }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold">{r.section}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
                    <span>{r.form}</span>
                    <Icon name="arrow-right" size={12} />
                    <span className="inline-flex items-center gap-[5px]">
                      <Icon name="graduation-cap" size={13} />
                      {r.competency}
                    </span>
                  </div>
                </div>
                <span
                  className="w-[52px] text-right text-[11.5px] font-semibold"
                  style={{ color: r.enabled ? 'var(--success-text)' : 'var(--text-tertiary)' }}
                >
                  {r.enabled ? 'Active' : 'Paused'}
                </span>
                <Switch
                  checked={r.enabled}
                  onChange={() => toggleRule.mutate(r.id)}
                  aria-label={`Toggle rule ${r.section}`}
                />
                <button
                  onClick={() => removeRule.mutate(r.id)}
                  aria-label={`Remove rule ${r.section}`}
                  className="fai-chip-btn grid h-[30px] w-[30px] flex-none place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover"
                >
                  <Icon name="trash-2" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
