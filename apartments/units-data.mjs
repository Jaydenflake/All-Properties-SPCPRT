/**
 * fetchUnitsData() — MOCK MVP for Canyon Vista Apartments.
 *
 * ---------------------------------------------------------------------------
 * Where to plug in RentCafe / Yardi later
 * ---------------------------------------------------------------------------
 * Replace the body of fetchUnitsData() with an HTTP call that maps your
 * vendor payload into the shape below. Example sketch:
 *
 *   const res = await fetch(`${API_BASE}/v1/properties/${PROPERTY_ID}/units`, {
 *     headers: {
 *       Authorization: `Bearer ${RENTCAFE_API_KEY}`,
 *       Accept: 'application/json',
 *     },
 *   });
 *   if (!res.ok) throw new Error(`RentCafe ${res.status}`);
 *   const data = await res.json();
 *   return data.units.map((u) => ({
 *     unitNumber: String(u.unitNumber ?? u.UnitNumber),
 *     price: Number(u.rent ?? u.MarketRent),
 *     available: u.available === true || u.status === 'Available',
 *     beds: Number(u.beds ?? u.Bedrooms),
 *     baths: Number(u.baths ?? u.Bathrooms),
 *     sqft: Number(u.sqft ?? u.SquareFeet),
 *     applyUrl: String(u.applyUrl ?? u.ApplyNowUrl ?? ''),
 *   }));
 *
 * Marker positions stay in unit-positions.mjs (localStorage + admin) — they are
 * not returned by RentCafe; managers maintain the 3D mapping separately.
 * ---------------------------------------------------------------------------
 */

/** @typedef {{ unitNumber: string, price: number, available: boolean, beds: number, baths: number, sqft: number, applyUrl: string }} Unit */

const MOCK_UNITS = [
  { unitNumber: '204', price: 1199, available: true, beds: 1, baths: 1, sqft: 512, applyUrl: 'https://example.com/apply/204' },
  { unitNumber: '208', price: 1249, available: true, beds: 1, baths: 1, sqft: 528, applyUrl: 'https://example.com/apply/208' },
  { unitNumber: '212', price: 1395, available: false, beds: 2, baths: 2, sqft: 892, applyUrl: 'https://example.com/apply/212' },
  { unitNumber: '302', price: 1295, available: true, beds: 1, baths: 1, sqft: 512, applyUrl: 'https://example.com/apply/302' },
  { unitNumber: '305', price: 1549, available: true, beds: 2, baths: 2, sqft: 905, applyUrl: 'https://example.com/apply/305' },
  { unitNumber: '308', price: 1599, available: false, beds: 2, baths: 2, sqft: 921, applyUrl: 'https://example.com/apply/308' },
  { unitNumber: '401', price: 1329, available: true, beds: 1, baths: 1, sqft: 528, applyUrl: 'https://example.com/apply/401' },
  { unitNumber: '405', price: 1629, available: false, beds: 2, baths: 2, sqft: 905, applyUrl: 'https://example.com/apply/405' },
  { unitNumber: '408', price: 1679, available: true, beds: 2, baths: 2, sqft: 933, applyUrl: 'https://example.com/apply/408' },
  { unitNumber: '412', price: 1895, available: true, beds: 3, baths: 2, sqft: 1156, applyUrl: 'https://example.com/apply/412' },
];

export async function fetchUnitsData() {
  await new Promise((r) => setTimeout(r, 0));
  return MOCK_UNITS.map((u) => ({ ...u }));
}
