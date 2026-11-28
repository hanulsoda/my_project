'use strict';
const data = require('../data/passages.json');

const GRADE_BANDS = Object.freeze(Object.keys(data));
const byId = new Map();
for (const band of GRADE_BANDS) for (const p of data[band]) byId.set(p.id, p);

// Copies, so callers can't mutate the shared data.
function listPassages(gradeBand) {
  return GRADE_BANDS.includes(gradeBand) ? data[gradeBand].map((p) => ({ ...p })) : [];
}

function getPassage(id) {
  const p = byId.get(id);
  return p ? { ...p } : null;
}

module.exports = { GRADE_BANDS, listPassages, getPassage };
