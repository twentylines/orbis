import { expect, test } from 'bun:test';
import { calculate, convertCurrency } from './search-calculator';

const examples: [string, string][] = [
  ['1+1', '2'],
  ['0.1 + 0.2', '0.3'],
  ['2+3*4', '14'],
  ['(2+3)*4', '20'],
  ['-3*-2', '6'],
  ['1--2', '3'],
  ['-(2+3)/2', '-2.5'],
  ['10/2/5', '1'],
  ['10-(2-3)', '11'],
  ['.5 + .25', '0.75'],
  ['2 × 3 ÷ 4 =', '1.5'],
  ['9007199254740993+1', '9007199254740994'],
  ['1/8', '0.125'],
  ['1/3*3', '1'],
  ['1/1000000000000', '0.000000000001'],
  ['-0+0', '0'],
  ['1/3', '0.333333333333'],
  ['2/3', '0.666666666667'],
  ['2^3^2', '512'],
  ['-2^2', '-4'],
  ['(-2)^2', '4'],
  ['2^-3', '0.125'],
  ['2^-2^2', '0.0625'],
  ['0.1^2', '0.01'],
  ['1e3*2', '2000'],
  ['1.2e-3+2.3E-3', '0.0035'],
  ['1e+3+2', '1002'],
  ['100*5%', '5'],
  ['(100+100)*5%', '10'],
  ['-5%', '-0.05'],
  ['2^3*4', '32'],
  ['0^2', '0'],
  ['5^0', '1'],
];
for (const [query, expected] of examples)
  test(`exact bounded arithmetic: ${query}`, () =>
    expect(calculate(query)).toEqual({ value: expected, approximate: query === '1/3' || query === '2/3' }));

for (const query of [
  '1/0',
  '0/0',
  '1+',
  '(1+2',
  '1..2+1',
  '1 2+3',
  '2(3)',
  '2**3',
  '2^101',
  '2^-101',
  '2^0.5',
  '0^0',
  '0^-1',
  '1e101*2',
  '1e-101+1',
  '1e+*2',
  '2^',
  '10^100^2',
  '1%2',
  `${'('.repeat(25)}1+1${')'.repeat(25)}`,
  '1+'.repeat(130),
  `${'9'.repeat(65)}+1`,
])
  test(`malformed or excessive arithmetic fails safely: ${query.slice(0, 32)}`, () => expect(calculate(query)).toHaveProperty('error'));
for (const query of ['jellyfin', 'filebrowser 2', '1+alert(1)', 'Math.random()', '1;globalThis', '600PHP', 'NaN+1', 'Infinity+1', '123'])
  test(`ordinary or executable input is not evaluated: ${query}`, () => expect(calculate(query)).toBeNull());

test('currency cross-rates use decimal rationals and the target minor units', () => {
  expect(convertCurrency('600', '69.832', '1.4144', 2)).toBe('12.15');
  expect(convertCurrency('0.1', '1', '3', 2)).toBe('0.30');
  expect(convertCurrency('1', '3', '1', 0)).toBe('0');
  expect(() => convertCurrency('1', '0', '1', 2)).toThrow();
});
