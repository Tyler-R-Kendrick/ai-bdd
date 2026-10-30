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
  const [text, setText] = useState(String(Number(value.toFixed(5)))),
    editing = useRef(false),
    cancel = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(String(Number(value.toFixed(5))));
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
        }}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={() => {
          editing.current = false;
          if (cancel.current) {
            cancel.current = false;
            setText(String(Number(value.toFixed(5))));
            return;
          }
          const parsed = Number(text);
          if (!text.trim() || !Number.isFinite(parsed)) {
            setText(String(Number(value.toFixed(5))));
            return;
          }
          const next = Math.max(min, Math.min(max, parsed));
          setText(String(Number(next.toFixed(5))));
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
