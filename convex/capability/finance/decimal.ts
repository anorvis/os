import { ConvexError } from "convex/values";

export type Decimal = { units: bigint; scale: number };

const int64Min = -(1n << 63n);
const int64Max = (1n << 63n) - 1n;

export function parseDecimal(input: string, label = "Value"): Decimal {
  const value = input.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} must be a plain decimal string`,
    });
  }
  let fraction = match[3] ?? "";
  if (fraction.length > 18) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} supports at most 18 decimal places`,
    });
  }
  fraction = fraction.replace(/0+$/, "");
  const scale = fraction.length;
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  let units = BigInt(digits || "0");
  if (match[1] === "-") units = -units;
  if (units < int64Min || units > int64Max) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: `${label} exceeds the supported exact range`,
    });
  }
  return { units, scale };
}
// Provider feeds (SnapTrade) report values like average cost with more
// precision than exact int64 storage can hold; rejecting them would fail the
// whole sync over insignificant digits. Truncate the fraction so the total
// digit count fits, then parse strictly.
export function parseProviderDecimal(input: string, label = "Value"): Decimal {
  const value = input.trim();
  const match = /^([+-]?)(\d+)\.(\d+)$/.exec(value);
  if (match === null) return parseDecimal(value, label);
  const integerDigits = match[2].replace(/^0+(?=\d)/, "");
  const keep = Math.min(match[3].length, Math.max(0, 18 - integerDigits.length), 12);
  const fraction = match[3].slice(0, keep).replace(/0+$/, "");
  return parseDecimal(
    `${match[1]}${match[2]}${fraction ? `.${fraction}` : ""}`,
    label,
  );
}


export function formatDecimal(value: Decimal): string {
  if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 18) {
    throw new Error("Invalid stored decimal scale");
  }
  const negative = value.units < 0n;
  let digits = (negative ? -value.units : value.units).toString();
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, "0");
    const split = digits.length - value.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  return negative && value.units !== 0n ? `-${digits}` : digits;
}

export function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = left.units * 10n ** BigInt(scale - left.scale);
  const rightUnits = right.units * 10n ** BigInt(scale - right.scale);
  const units = leftUnits + rightUnits;
  if (units < int64Min || units > int64Max) {
    throw new Error("Exact decimal sum exceeds the supported range");
  }
  return { units, scale };
}

export function zeroDecimal(): Decimal {
  return { units: 0n, scale: 0 };
}
