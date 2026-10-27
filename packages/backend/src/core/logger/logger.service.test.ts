import { type } from 'arktype';
import { describe, expect, it } from 'vitest';
import { redactSensitiveData } from './logger.service';

describe('validation log privacy', () => {
  it('does not serialize submitted values from validation error instances', () => {
    const input = 'do-not-log';
    const errors = type({ port: 'number' })({ port: input });
    expect(errors).toBeInstanceOf(type.errors);
    expect(JSON.stringify(errors)).toContain(input);
    expect(redactSensitiveData(errors)).toEqual({ validationErrors: 1 });
    expect(JSON.stringify(errors)).toContain(input);
  });

  it('redacts validation failures nested in structured log metadata', () => {
    const input = 'do-not-log';
    const errors = type({ port: 'number' })({ port: input });
    const result = JSON.stringify(redactSensitiveData({ details: [errors], password: input }));
    expect(result).not.toContain(input);
    expect(result).toContain('validationErrors');
  });
});
