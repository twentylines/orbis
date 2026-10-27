import clsx from 'clsx';
import type React from 'react';
import { useMemo } from 'react';
import './OtpInput.css';
import { CharacterInput } from '../Input/use-character-motion';

type Props = {
  value: string;
  valueLength: number;
  onChange: (value: string) => void;
  className?: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
};

const RE_DIGIT = /^\d+$/;

export const OtpInput = ({ value, valueLength, onChange, className, invalid, describedBy, disabled }: Props) => {
  const valueItems = useMemo(() => {
    const valueArray = value.split('');
    const items: string[] = [];

    for (let i = 0; i < valueLength; i += 1) {
      const char = valueArray[i];

      if (char && RE_DIGIT.test(char)) {
        items.push(char);
      } else {
        items.push('');
      }
    }

    return items;
  }, [value, valueLength]);

  const focusToNextInput = (target: HTMLElement) => {
    const inputs = [...(target.closest('fieldset')?.querySelectorAll('input') ?? [])];
    const nextElementSibling = inputs[inputs.indexOf(target as HTMLInputElement) + 1];

    if (nextElementSibling) {
      nextElementSibling.focus();
    }
  };
  const focusToPrevInput = (target: HTMLElement) => {
    const inputs = [...(target.closest('fieldset')?.querySelectorAll('input') ?? [])];
    const previousElementSibling = inputs[inputs.indexOf(target as HTMLInputElement) - 1];

    if (previousElementSibling) {
      previousElementSibling.focus();
    }
  };

  const inputOnChange = (e: React.ChangeEvent<HTMLInputElement>, idx: number) => {
    const { target } = e;
    let targetValue = target.value.trim();
    const isTargetValueDigit = RE_DIGIT.test(targetValue);

    if (!isTargetValueDigit && targetValue !== '') {
      return;
    }

    const nextInputEl = target.closest('fieldset')?.querySelectorAll('input')[idx + 1];

    // only delete digit if next input element has no value
    if (!isTargetValueDigit && nextInputEl && nextInputEl.value !== '') {
      return;
    }

    targetValue = isTargetValueDigit ? targetValue : ' ';

    const targetValueLength = targetValue.length;

    if (targetValueLength === 1) {
      const newValue = value.substring(0, idx) + targetValue + value.substring(idx + 1);

      onChange(newValue);

      if (!isTargetValueDigit) {
        return;
      }

      focusToNextInput(target);
    } else if (targetValueLength === valueLength) {
      onChange(targetValue);
    }
  };

  const inputOnFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    const { target } = e;

    const inputs = [...(target.closest('fieldset')?.querySelectorAll('input') ?? [])];
    const prevInputEl = inputs[inputs.indexOf(target) - 1];

    if (prevInputEl && prevInputEl.value === '') {
      return prevInputEl.focus();
    }

    target.setSelectionRange(0, target.value.length);

    return null;
  };

  const inputOnKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const { key } = e;
    const target = e.target as HTMLInputElement;

    if (key === 'ArrowRight' || key === 'ArrowDown') {
      e.preventDefault();
      return focusToNextInput(target);
    }

    if (key === 'ArrowLeft' || key === 'ArrowUp') {
      e.preventDefault();
      return focusToPrevInput(target);
    }

    const targetValue = target.value;
    target.setSelectionRange(0, targetValue.length);

    if (e.key !== 'Backspace' || target.value !== '') {
      return null;
    }

    focusToPrevInput(target);

    return null;
  };

  return (
    <div className="otp-control">
      <fieldset className="otp-group" aria-label="Authentication code" aria-describedby={describedBy} disabled={disabled}>
        {valueItems.map((digit, idx) => (
          <CharacterInput
            aria-label={`Digit ${idx + 1} of ${valueLength}`}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            onChange={(e) => inputOnChange(e, idx)}
            onKeyDown={inputOnKeyDown}
            onFocus={inputOnFocus}
            // biome-ignore lint/suspicious/noArrayIndexKey: The index is used as a key because the array is static
            key={idx}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{1}"
            maxLength={valueLength}
            className={clsx('form-control otp-input', className)}
            value={digit}
          />
        ))}
      </fieldset>
    </div>
  );
};
