/**
 * Renders a FormField as an interactive input. Shared by the builder's live
 * preview and the external fill flow, so a field looks and behaves identically
 * wherever it appears. Values use the shared SubmissionValue union.
 */
import {
  Checkbox,
  DateTimePicker,
  FileDropzone,
  Icon,
  Input,
  Radio,
  RepeatingGroup,
  Select,
  SignaturePad,
  Textarea,
  type RepeatingRow,
} from '@formai/ui';
import type { FormField, SubmissionValue } from '@formai/shared';

export interface FieldInputProps {
  field: FormField;
  value: SubmissionValue;
  onChange: (value: SubmissionValue) => void;
  error?: string;
  disabled?: boolean;
}

function asString(v: SubmissionValue): string {
  return v === null || v === undefined || Array.isArray(v) ? '' : String(v);
}

export function FieldInput({ field, value, onChange, error, disabled }: FieldInputProps) {
  if (field.type === 'section_header') {
    return (
      <div className="border-b border-border-subtle pb-2 pt-2">
        <h4 className="text-[15px] font-bold text-text-primary">{field.label}</h4>
        {field.help && <p className="mt-1 text-[12.5px] text-text-tertiary">{field.help}</p>}
      </div>
    );
  }

  const label = (
    <div className="mb-1.5 text-[13px] font-semibold text-text-primary">
      {field.label}
      {field.required && <span className="ml-0.5 text-danger">*</span>}
    </div>
  );
  const helpErr = error ? (
    <p className="mt-1 text-xs text-danger-text">{error}</p>
  ) : field.help ? (
    <p className="mt-1 text-xs text-text-tertiary">{field.help}</p>
  ) : null;

  const body = (() => {
    switch (field.type) {
      case 'text':
        return (
          <Input
            value={asString(value)}
            placeholder={field.placeholder}
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'number':
        return (
          <Input
            type="number"
            value={asString(value)}
            placeholder={field.placeholder}
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'textarea':
        return (
          <Textarea
            value={asString(value)}
            placeholder={field.placeholder}
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'date':
        return (
          <DateTimePicker value={asString(value)} onChange={(v) => onChange(v)} disabled={disabled} />
        );
      case 'dropdown':
        return (
          <Select
            options={field.options ?? []}
            value={asString(value)}
            placeholder="Select an option…"
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'radio':
        return (
          <div className="flex flex-col gap-2">
            {(field.options ?? []).map((o) => (
              <Radio
                key={o}
                name={field.id}
                label={o}
                checked={asString(value) === o}
                disabled={disabled}
                onChange={() => onChange(o)}
              />
            ))}
          </div>
        );
      case 'boolean_yes_no':
        return (
          <div className="flex gap-4">
            {['Yes', 'No'].map((o) => (
              <Radio
                key={o}
                name={field.id}
                label={o}
                checked={(value === true && o === 'Yes') || (value === false && o === 'No')}
                disabled={disabled}
                onChange={() => onChange(o === 'Yes')}
              />
            ))}
          </div>
        );
      case 'checkbox':
        return (
          <Checkbox
            label={field.label}
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
        );
      case 'checkbox_group': {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div className="flex flex-col gap-2">
            {(field.options ?? []).map((o) => (
              <Checkbox
                key={o}
                label={o}
                checked={selected.includes(o)}
                disabled={disabled}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...selected, o] : selected.filter((x) => x !== o),
                  )
                }
              />
            ))}
          </div>
        );
      }
      case 'signature':
        return (
          <SignaturePad
            value={asString(value)}
            onChange={(v) => onChange(v)}
            aria-label={field.label}
          />
        );
      case 'file_upload':
        return (
          <FileDropzone
            onFiles={(files) => onChange(files[0]?.name ?? '')}
            selectedName={asString(value) || undefined}
            hint="PDF, image or document"
          />
        );
      case 'repeating_group':
        return (
          <RepeatingGroup
            columns={field.columns ?? []}
            rows={Array.isArray(value) ? (value as RepeatingRow[]) : []}
            onChange={(rows) => onChange(rows)}
            readOnly={disabled}
          />
        );
      default:
        return (
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 text-[13px] text-text-tertiary">
            <Icon name="help-circle" size={15} />
            {field.type}
          </div>
        );
    }
  })();

  // Single checkbox already carries its own label.
  if (field.type === 'checkbox') {
    return (
      <div>
        {body}
        {helpErr}
      </div>
    );
  }

  return (
    <div>
      {label}
      {body}
      {helpErr}
    </div>
  );
}
