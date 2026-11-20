/** Small, bounded decimal calculator. Input is parsed as data; never executed as JavaScript. */
type Fraction = { numerator: bigint; denominator: bigint };
export type Calculation = { value: string; approximate: boolean } | { error: string };
const limit = 1024;
const gcd = (left: bigint, right: bigint): bigint => {
  let a = left;
  let b = right;
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
};
function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (denominator === 0n) throw new Error('Cannot divide by zero.');
  if (numerator.toString().length > limit || denominator.toString().length > limit) throw new Error('This calculation is too large.');
  const divisor = gcd(numerator, denominator);
  const sign = denominator < 0n ? -1n : 1n;
  return { numerator: (numerator / divisor) * sign, denominator: (denominator / divisor) * sign };
}
function decimal(value: string): Fraction {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || value.length > 64) throw new Error('Use numbers with at most 64 digits.');
  const [coefficient = '', exponentText = '0'] = value.toLowerCase().split('e');
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Scientific exponents must be between -100 and 100.');
  const negative = coefficient.startsWith('-');
  const [whole, tail = ''] = coefficient.replace(/^[+-]/, '').split('.');
  const numerator = BigInt(`${whole || '0'}${tail}`) * (negative ? -1n : 1n);
  const scale = tail.length - exponent;
  return scale >= 0 ? fraction(numerator, 10n ** BigInt(scale)) : fraction(numerator * 10n ** BigInt(-scale));
}
function power(base: Fraction, exponent: Fraction): Fraction {
  if (exponent.denominator !== 1n) throw new Error('Powers require a whole-number exponent.');
  if (exponent.numerator < -100n || exponent.numerator > 100n) throw new Error('Powers must be between -100 and 100.');
  if (base.numerator === 0n && exponent.numerator === 0n) throw new Error('Zero to the power of zero is undefined.');
  const negative = exponent.numerator < 0n;
  const magnitude = negative ? -exponent.numerator : exponent.numerator;
  return negative
    ? fraction(base.denominator ** magnitude, base.numerator ** magnitude)
    : fraction(base.numerator ** magnitude, base.denominator ** magnitude);
}
function format(value: Fraction, places: number, fixed = false): { value: string; approximate: boolean } {
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const scale = 10n ** BigInt(places);
  const scaled = numerator * scale;
  const approximate = scaled % value.denominator !== 0n;
  const rounded = scaled / value.denominator + (2n * (scaled % value.denominator) >= value.denominator ? 1n : 0n);
  const digits = rounded.toString().padStart(places + 1, '0');
  const untrimmed = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  const output = places && !fixed ? untrimmed.replace(/\.?0+$/, '') : untrimmed;
  return { value: `${negative && rounded !== 0n ? '-' : ''}${output}`, approximate };
}
export function calculate(query: string): Calculation | null {
  const source = query
    .trim()
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('−', '-')
    .replace(/\s*=\s*$/, '');
  // Ordinary app names (including numbered ones) never become calculations.
  if (!/^[\d.eE\s()%+*/^-]+$/.test(source) || !/\d/.test(source) || !/[+*/()%^eE-]/.test(source)) return null;
  if (/[eE]/.test(source) && !/(?:\d(?:\.\d*)?|\.\d+)[eE]/.test(source)) return null;
  if (source.length > 256) return { error: 'Keep calculations within 256 characters.' };
  try {
    const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[^\s]/g) ?? [];
    if (tokens.length > 128) throw new Error('This calculation has too many steps.');
    let index = 0;
    let depth = 0;
    const primary = (): Fraction => {
      const token = tokens[index++];
      let result: Fraction;
      if (token === '(') {
        result = expression();
        if (tokens[index++] !== ')') throw new Error('Check the parentheses.');
      } else {
        if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) throw new Error('Complete the calculation.');
        result = decimal(token);
      }
      while (tokens[index] === '%') {
        index += 1;
        result = fraction(result.numerator, result.denominator * 100n);
      }
      return result;
    };
    const unary = (): Fraction => {
      depth += 1;
      if (depth > 24) throw new Error('This calculation is nested too deeply.');
      let result: Fraction;
      if (tokens[index] === '+' || tokens[index] === '-') {
        const operator = tokens[index++];
        result = unary();
        if (operator === '-') result = fraction(-result.numerator, result.denominator);
      } else {
        result = primary();
        if (tokens[index] === '^') {
          index += 1;
          result = power(result, unary());
        }
      }
      depth -= 1;
      return result;
    };
    const product = (): Fraction => {
      let left = unary();
      while (tokens[index] === '*' || tokens[index] === '/') {
        const operator = tokens[index++];
        const right = unary();
        left =
          operator === '*'
            ? fraction(left.numerator * right.numerator, left.denominator * right.denominator)
            : fraction(left.numerator * right.denominator, left.denominator * right.numerator);
      }
      return left;
    };
    const expression = (): Fraction => {
      let left = product();
      while (tokens[index] === '+' || tokens[index] === '-') {
        const operator = tokens[index++];
        const right = product();
        left = fraction(
          left.numerator * right.denominator + (operator === '+' ? 1n : -1n) * right.numerator * left.denominator,
          left.denominator * right.denominator,
        );
      }
      return left;
    };
    const result = expression();
    if (index !== tokens.length) throw new Error('Check the numbers and operators.');
    return format(result, 12);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'This calculation could not be completed.' };
  }
}

export function convertCurrency(amount: string, fromRate: string, toRate: string, decimalPlaces: number) {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) throw new Error('Unsupported currency precision.');
  const value = decimal(amount);
  const from = decimal(fromRate);
  const to = decimal(toRate);
  if (from.numerator <= 0n || to.numerator <= 0n) throw new Error('Exchange rates are unavailable.');
  return format(fraction(value.numerator * to.numerator * from.denominator, value.denominator * to.denominator * from.numerator), decimalPlaces, true)
    .value;
}
