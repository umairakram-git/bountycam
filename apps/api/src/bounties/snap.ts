// POLICY.md section 9.1: deterministic grid snap in scaled-integer arithmetic
// only — no floating point, no jitter (D58). The sole production caller is
// bounty creation, after the section 5 form checks have passed.
import { toScaled } from "./gps.ts";

const SCALE = 10_000_000n;
const CELL = 100_000n;
const HALF_CELL = 50_000n;

// BigInt division truncates toward zero; section 9.1 step 2 requires floor —
// rounding toward negative infinity, so a scaled value of -1 lands in cell
// -1, not cell 0. The divisor here is always positive.
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Section 9.1 step 5: sign if strictly negative, integer part, full stop,
// seven fraction digits. Takes cell centres only: centres always end in
// 50000n, so the input is never zero and negative zero cannot arise — a
// property of the caller, not of this function.
function render(scaled: bigint): string {
  const sign = scaled < 0n ? "-" : "";
  const abs = scaled < 0n ? -scaled : scaled;
  const integer = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(7, "0");
  return `${sign}${integer.toString()}.${fraction}`;
}

function snap(value: string, minCell: bigint, maxCell: bigint): string {
  const cell = clamp(floorDiv(toScaled(value), CELL), minCell, maxCell);
  return render(cell * CELL + HALF_CELL);
}

export function snapLat(value: string): string {
  return snap(value, -9000n, 8999n);
}

export function snapLon(value: string): string {
  return snap(value, -18000n, 17999n);
}
