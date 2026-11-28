'use strict';
// Minimal CSV writer for spreadsheet exports (RFC 4180 quoting, CRLF, UTF-8 BOM so Excel reads
// Hangul correctly).
//
// Formula injection: a cell whose first character (also after leading whitespace) is = + - @,
// their full-width look-alikes, tab, CR or LF can be run as a formula by Excel, LibreOffice and
// Sheets, so such text gets a single quote prefix (shown as plain text there). Numbers and
// booleans never need it (a negative figure stays a number), and null/undefined are empty cells.
const FORMULA_LEAD = /^[=+\-@＝＋－＠\t\r\n]/;
const NEEDS_QUOTES = /[",\r\n]/;
const BOM = '﻿';

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && (FORMULA_LEAD.test(s) || FORMULA_LEAD.test(s.trimStart()))) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return BOM + rows.map((row) => `${row.map(csvCell).join(',')}\r\n`).join('');
}

module.exports = { csvCell, toCsv };
