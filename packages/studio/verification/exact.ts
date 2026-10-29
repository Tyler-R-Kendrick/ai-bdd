/** A tiny exact rational arithmetic kernel; no floating-point proof steps. */
export type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

export function rational(
  numerator: bigint | number,
  denominator: bigint | number = 1n,
): Rational {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === 0n) throw new RangeError('Rational denominator must be nonzero');
  const divisor = gcd(n, d);
  const sign = d < 0n ? -1n : 1n;
  return { numerator: (sign * n) / divisor, denominator: (sign * d) / divisor };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function affineBounds(
  slope: Rational,
  intercept: Rational,
  lower: Rational,
  upper: Rational,
) {
  if (compare(lower, upper) > 0) throw new RangeError('Interval is reversed');
  const atLower = add(multiply(slope, lower), intercept);
  const atUpper = add(multiply(slope, upper), intercept);
  return compare(slope, rational(0)) >= 0
    ? { lower: atLower, upper: atUpper }
    : { lower: atUpper, upper: atLower };
}

export function format(value: Rational): string {
  return value.denominator === 1n
    ? String(value.numerator)
    : `${value.numerator}/${value.denominator}`;
}
