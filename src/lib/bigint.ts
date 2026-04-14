export const NANOSATS_PER_SAT = 1_000_000_000n;

export function stringifyBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyBigInts(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, innerValue]) => [
        key,
        stringifyBigInts(innerValue),
      ]),
    );
  }

  return value;
}

export function priceNanosatsPerAtom(
  paidSats: bigint,
  soldAtoms: bigint,
): bigint {
  if (soldAtoms <= 0n) {
    throw new Error("soldAtoms must be positive");
  }

  return (paidSats * NANOSATS_PER_SAT) / soldAtoms;
}
