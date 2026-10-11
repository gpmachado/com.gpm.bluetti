'use strict';

// Helpers for diagnostic logging. Logs end up in user diagnostic reports, so they must never
// contain tokens or account data; serial numbers are shortened.

function maskSn(sn) {
  const s = String(sn || '');
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// "SOC=97 GridAllTotalPower=0 …" from a cloud stateList.
function formatStates(stateList) {
  return (stateList || [])
    .filter((e) => e && e.fnCode)
    .map((e) => `${e.fnCode}=${e.fnValue}`)
    .join(' ');
}

module.exports = { maskSn, formatStates };
