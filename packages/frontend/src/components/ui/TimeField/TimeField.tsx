import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { InlineFeedback } from '../Alert/Alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../Select';
import {
  changeTimeFormat,
  createTimeField,
  editTimeField,
  finishTimeField,
  parseTimeText,
  readTimeFields,
  timeFieldError,
  type TimeFormat,
  type TimePart,
  type TimePeriod,
} from './time-field';
import './TimeField.css';

export function useTimeField({
  value,
  format = '12h',
  onChange,
  onFormatChange,
}: {
  value: string | null;
  format?: TimeFormat;
  onChange: (value: string | null) => void;
  onFormatChange?: (format: TimeFormat) => void;
}) {
  const [state, setState] = useState(() => createTimeField(value, format));
  const emitted = useRef(value);
  const observedFormat = useRef(format);
  useEffect(() => {
    const formatChanged = observedFormat.current !== format;
    observedFormat.current = format;
    if (emitted.current !== value) {
      emitted.current = value;
      setState(createTimeField(value, format));
    } else if (formatChanged)
      setState((previous) =>
        previous.format === format || !readTimeFields(previous.fields, previous.format) ? previous : changeTimeFormat(previous, format),
      );
  }, [value, format]);
  const emit = (next: typeof state) => {
    setState(next);
    const canonical = readTimeFields(next.fields, next.format);
    const changed = canonical !== emitted.current;
    emitted.current = canonical;
    if (changed) onChange(canonical);
  };
  return {
    state,
    value: readTimeFields(state.fields, state.format),
    edit: (part: TimePart, input: string) => emit(editTimeField(state, part, input)),
    finish: () => {
      const next = finishTimeField(state);
      emit(next);
      return Boolean(readTimeFields(next.fields, next.format));
    },
    revert: () => emit(createTimeField(state.committed, state.format)),
    period: (period: TimePeriod) => emit({ ...state, fields: { ...state.fields, period } }),
    format: (next: TimeFormat) => {
      const changed = changeTimeFormat(state, next);
      setState(changed);
      if (changed.format === next) onFormatChange?.(next);
    },
  };
}

export function TimeField({
  control,
  label,
  id: suppliedId,
  name,
  disabled = false,
  describedBy,
}: {
  control: ReturnType<typeof useTimeField>;
  label: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const minute = useRef<HTMLInputElement>(null);
  const { fields, format, touched } = control.state;
  const error = touched && !control.value ? timeFieldError(format) : null;
  const description = [describedBy, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  const key = (event: KeyboardEvent<HTMLInputElement>, part: TimePart) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (control.finish()) {
        if (part === 'hour') minute.current?.focus();
        else event.currentTarget.blur();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      control.revert();
    }
  };
  return (
    <fieldset className="orbis-time-field" aria-describedby={description}>
      <legend>{label}</legend>
      <div className="orbis-time-parts" data-format={format}>
        {(['hour', 'minute'] as const).map((part) => (
          <Fragment key={part}>
            {part === 'minute' ? (
              <span aria-hidden="true" className="orbis-time-separator">
                :
              </span>
            ) : null}
            <input
              ref={part === 'minute' ? minute : undefined}
              id={`${id}-${part}`}
              className="form-control orbis-time-input"
              type="text"
              inputMode="numeric"
              aria-label={`${label} ${part}${part === 'hour' ? (format === '12h' ? ', 1 to 12' : ', 00 to 23') : ', 00 to 59'}`}
              aria-invalid={Boolean(error)}
              aria-describedby={description}
              value={fields[part]}
              maxLength={16}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => control.edit(part, event.target.value)}
              onBlur={control.finish}
              onKeyDown={(event) => key(event, part)}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text');
                if (parseTimeText(text)) {
                  event.preventDefault();
                  control.edit(part, text);
                }
              }}
            />
          </Fragment>
        ))}
        {format === '12h' ? (
          <Select
            value={fields.period}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === 'AM' || value === 'PM') control.period(value);
            }}
          >
            <SelectTrigger fitContent className="orbis-time-period" aria-label={`${label} AM or PM`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AM">AM</SelectItem>
              <SelectItem value="PM">PM</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {error ? <InlineFeedback id={`${id}-error`}>{error}</InlineFeedback> : null}
      <div className="orbis-time-format">
        <span id={`${id}-format-label`}>Time format</span>
        <Select
          value={format}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === '12h' || next === '24h') control.format(next);
          }}
        >
          <SelectTrigger fitContent className="orbis-time-format-select" aria-labelledby={`${id}-format-label`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="12h">12-hour</SelectItem>
            <SelectItem value="24h">24-hour</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {name ? <input type="hidden" name={name} value={control.value ?? ''} disabled={disabled} /> : null}
    </fieldset>
  );
}
