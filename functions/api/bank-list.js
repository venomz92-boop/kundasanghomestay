// /api/bank-list.js — Returns the list of bank codes supported by CHIP Send.
//
// CHIP does not expose a dedicated "list banks" API endpoint, so this list
// mirrors the "Add a bank account" documentation. If CHIP adds or removes a
// bank, update this file and every page updates automatically.
//
// CHIP Send uses SWIFT/BIC codes (e.g. MBBEMYKL), NOT FPX codes.
// Source: https://docs.chip-in.asia/chip-send/api-reference/bank-accounts/create
//
// This file is read by:
//   - list.html (host submission form — populates the bank dropdown)
//   - admin.html (admin edit modal — validates the bank code before save)
//
// The same code list is also embedded in pending.js and _utils.js as a
// hard-coded Set, so submissions and payouts are validated server-side
// even if a client tries to bypass this endpoint. If you add a bank
// here, add it to those two files as well.

import { corsHeaders, enforceHttps, jsonResponse } from './_utils.js';

// Complete list from CHIP Send documentation (retrieved 2026).
// Sorted alphabetically by bank name for the dropdown.
const CHIP_SEND_BANKS = [
  { code: 'ACDBMYK2', name: 'AEON Bank (M) Berhad' },
  { code: 'PHBMMYKL', name: 'Affin Bank Berhad' },
  { code: 'AGOBMYKL', name: 'Agrobank' },
  { code: 'RJHIMYKL', name: 'Al-Rajhi' },
  { code: 'MFBBMYKL', name: 'Alliance Bank Malaysia Berhad' },
  { code: 'ARBKMYKL', name: 'Ambank Malaysia Berhad' },
  { code: 'BIMBMYKL', name: 'Bank Islam Malaysia Berhad' },
  { code: 'BKRMMYKL', name: 'Bank Kerjasama Rakyat Malaysia Berhad' },
  { code: 'BMMBMYKL', name: 'Bank Muamalat Malaysia Bhd' },
  { code: 'BOFAMY2X', name: 'Bank of America (M) Berhad' },
  { code: 'BKCHMYKL', name: 'Bank of China (M) Berhad' },
  { code: 'BOTKMYKX', name: 'Bank of Tokyo-Mitsubishi UFJ (M) Berhad' },
  { code: 'BSNAMYK1', name: 'Bank Simpanan Nasional Berhad' },
  { code: 'BNPAMYKL', name: 'BNP Paribas Malaysia Berhad' },
  { code: 'PCBCMYKL', name: 'China Construction Bank (M) Berhad' },
  { code: 'CIBBMYKL', name: 'CIMB Bank Berhad' },
  { code: 'DEUTMYKL', name: 'Deutsche Bank (Malaysia) Berhad' },
  { code: 'FNXSMYNB', name: 'Finexus Cards Sdn. Bhd.' },
  { code: 'GXSPMYKL', name: 'GX Bank Berhad' },
  { code: 'HLBBMYKL', name: 'Hong Leong Bank Berhad' },
  { code: 'HBMBMYKL', name: 'HSBC Bank Malaysia Berhad' },
  { code: 'ICBKMYKL', name: 'Industrial and Commercial Bank of China (M) Berhad' },
  { code: 'CHASMYKX', name: 'JP Morgan Chase Bank Berhad' },
  { code: 'KFHOMYKL', name: 'Kuwait Finance House' },
  { code: 'MBBEMYKL', name: 'Maybank Berhad' },
  { code: 'AFBQMYKL', name: 'MBSB Bank Berhad' },
  { code: 'MHCBMYKA', name: 'Mizuho Bank (Malaysia) Berhad' },
  { code: 'OCBCMYKL', name: 'OCBC Bank Berhad' },
  { code: 'PBBEMYKL', name: 'Public Bank Berhad' },
  { code: 'RHBBMYKL', name: 'RHB Bank Berhad' },
  { code: 'SCBLMYKX', name: 'Standard Chartered Bank Malaysia Berhad' },
  { code: 'SMBCMYKL', name: 'Sumitomo Mitsui Banking Corporation (M) Berhad' },
  { code: 'TNGDMYNB', name: "Touch 'n Go eWallet" },
  { code: 'UOVBMYKL', name: 'United Overseas Bank Berhad (UOB)' }
];

export async function onRequestGet({ request, env }) {
  const redirect = enforceHttps(request);
  if (redirect) return redirect;

  // Cache for 24 hours — CHIP's bank list changes very rarely.
  return jsonResponse({
    success: true,
    count: CHIP_SEND_BANKS.length,
    banks: CHIP_SEND_BANKS
  }, 200, request, {
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { headers: corsHeaders(request) });
}
