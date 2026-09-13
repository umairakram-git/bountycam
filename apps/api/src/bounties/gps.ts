// POLICY.md section 5: the GPS seven-decimal profile, checked at the producer
// boundary (D61). packages/shared stays profile-agnostic.

// Rules 1 to 5: ASCII digits only ([0-9] without the u flag matches nothing
// else), at most one leading hyphen-minus, integer part without leading
// zeros, exactly one full stop, exactly seven fraction digits.
const PROFILE_FORM = /^-?(?:0|[1-9][0-9]*)\.[0-9]{7}$/;

const SCALE = 10_000_000n;

// Section 9.1 step 1: remove the full stop, parse the signed digits. Exact by
// construction — the profile fixes seven fraction digits. Callers must have
// checked the form first.
export function toScaled(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function passesProfile(value: string, maxDegrees: bigint): boolean {
  if (!PROFILE_FORM.test(value)) return false;
  const scaled = toScaled(value);
  // Rule 6: the sign appears only when the value is strictly negative, so a
  // signed all-zero numeral is rejected.
  if (value.startsWith("-") && scaled === 0n) return false;
  // Rule 7: range, checked numerically after the form rules.
  const bound = maxDegrees * SCALE;
  return scaled >= -bound && scaled <= bound;
}

export function isValidLat(value: string): boolean {
  return passesProfile(value, 90n);
}

export function isValidLon(value: string): boolean {
  return passesProfile(value, 180n);
}
