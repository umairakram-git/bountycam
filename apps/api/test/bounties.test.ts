import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidLat, isValidLon } from "../src/bounties/gps.ts";
import { snapLat, snapLon } from "../src/bounties/snap.ts";

// --- snap unit tests (POLICY.md section 12, tests 73 to 75; vector V3) ---

test("73 section 9.1 worked examples and V3 rows reproduce", () => {
  // The two positive extremes are the only clamped rows: cell 9000 clamps to
  // 8999, cell 18000 to 17999.
  assert.equal(snapLat("90.0000000"), "89.9950000");
  assert.equal(snapLon("180.0000000"), "179.9950000");
  // Exact, not clamped: -1800000000n / 100000n is -18000n with zero
  // remainder, already the lowest longitude cell.
  assert.equal(snapLon("-180.0000000"), "-179.9950000");
  // V1's coordinates (V3 rows 4 and 5).
  assert.equal(snapLat("40.4405556"), "40.4450000");
  assert.equal(snapLon("-79.9961111"), "-79.9950000");
});

test("74 -0.0000001 snaps to -0.0050000: floor division, not truncation", () => {
  // Truncation toward zero would put scaled -1 in cell 0 (centre 0.0050000);
  // floor puts it in cell -1.
  assert.equal(snapLat("-0.0000001"), "-0.0050000");
});

test("75 snap output passes the section 5 form rules; snap is deterministic", () => {
  const lats = ["90.0000000", "-0.0000001", "40.4405556"];
  const lons = ["180.0000000", "-180.0000000", "-79.9961111"];
  // Section 11 closure: a snapped coordinate must still be a valid
  // coordinate, or location_public holds something the producer boundary
  // would reject.
  for (const lat of lats) {
    const snapped = snapLat(lat);
    assert.equal(isValidLat(snapped), true, `snapLat(${lat}) form`);
    assert.equal(snapLat(lat), snapped, `snapLat(${lat}) determinism`);
  }
  for (const lon of lons) {
    const snapped = snapLon(lon);
    assert.equal(isValidLon(snapped), true, `snapLon(${lon}) form`);
    assert.equal(snapLon(lon), snapped, `snapLon(${lon}) determinism`);
  }
});
