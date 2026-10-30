import { useEffect, useRef, useState } from 'react';
import { Field, Input } from '../../components/ui.tsx';
export function MidiNumberField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const format = (value: number) =>
    String(Number(value.toFixed(step >= 1 ? 3 : 5)));
  const [text, setText] = useState(format(value)),
    editing = useRef(false),
    cancel = useRef(false),
    modified = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(format(value));
  }, [value]);
  return (
    <Field label={label}>
      <Input
        aria-label={label}
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onFocus={() => {
          editing.current = true;
          modified.current = false;
        }}
        onChange={(event) => {
          modified.current = true;
          setText(event.currentTarget.value);
        }}
        onBlur={() => {
          editing.current = false;
          if (!modified.current || cancel.current) {
            cancel.current = false;
            setText(format(value));
            return;
          }
          const parsed = Number(text);
          if (!text.trim() || !Number.isFinite(parsed)) {
            setText(format(value));
            return;
          }
          const next = Math.max(min, Math.min(max, parsed));
          setText(format(next));
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            cancel.current = true;
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}
