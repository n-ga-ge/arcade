// Conditional requests and byte ranges (RFC 9110, sections 13 and 14), worked
// out here instead of handing the request headers to R2: the Worker needs the
// same answers for objects that come from the edge cache, and R2 reports every
// failed precondition the same way, so 304 and 412 could not be told apart.

export const UNSATISFIABLE = Symbol('unsatisfiable');

// The entity tags in an If-Match or If-None-Match list.
function tags(list) {
  return list.match(/(?:W\/)?"[^"]*"/g) ?? [];
}

function weak(tag) {
  return tag.startsWith('W/');
}

function opaque(tag) {
  return weak(tag) ? tag.slice(2) : tag;
}

function strongMatch(list, etag) {
  if (list.trim() === '*') return true;
  return !weak(etag) && tags(list).includes(etag);
}

function weakMatch(list, etag) {
  if (list.trim() === '*') return true;
  return tags(list).some((tag) => opaque(tag) === opaque(etag));
}

function httpDate(value) {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

// What the request's preconditions make of an object that exists: 412, 304, or
// 200 to go on. `modified` is in milliseconds, already cut to whole seconds.
export function evaluatePreconditions(headers, { etag, modified }) {
  const ifMatch = headers.get('If-Match');
  if (ifMatch !== null) {
    if (!strongMatch(ifMatch, etag)) return 412;
  } else {
    const since = httpDate(headers.get('If-Unmodified-Since'));
    if (since !== null && modified > since) return 412;
  }
  const ifNoneMatch = headers.get('If-None-Match');
  if (ifNoneMatch !== null) {
    if (weakMatch(ifNoneMatch, etag)) return 304;
  } else {
    const since = httpDate(headers.get('If-Modified-Since'));
    if (since !== null && modified <= since) return 304;
  }
  return 200;
}

// A client resuming a download sends If-Range with the validator of the part
// it already has. When that no longer matches, it must get the whole object.
function ifRangeHolds(value, etag, modified) {
  if (value.startsWith('"') || weak(value)) return !weak(etag) && value === etag;
  return httpDate(value) === modified;
}

// The byte range to send for a GET: null for the whole object (no Range
// header, one that is ignored, or a failed If-Range), UNSATISFIABLE for a 416,
// else { start, end } with both ends inclusive.
export function resolveRange(headers, { etag, modified, size }) {
  const header = headers.get('Range');
  if (header === null) return null;
  const ifRange = headers.get('If-Range');
  if (ifRange !== null && !ifRangeHolds(ifRange.trim(), etag, modified)) return null;
  return parseRange(header, size);
}

// Several ranges would need a multipart answer. A server may ignore a Range
// header, and the whole object is a correct reply to those, as it is to a
// header that is not a byte range at all. So only this form counts.
const SINGLE_RANGE = /^\s*bytes=(\d*)-(\d*)\s*$/i;

function singleRange(header) {
  const match = SINGLE_RANGE.exec(header);
  return match && (match[1] !== '' || match[2] !== '') ? match : null;
}

// Whether a Range header asks for one byte range, before the object's size is
// known (the range may still turn out to be unsatisfiable or malformed).
export function isSingleRange(header) {
  return singleRange(header) !== null;
}

export function parseRange(header, size) {
  const match = singleRange(header);
  if (!match) return null;
  if (match[1] === '') {
    const length = Number(match[2]);
    if (length === 0 || size === 0) return UNSATISFIABLE;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] === '' ? Infinity : Number(match[2]);
  if (last < start) return null;
  if (start >= size) return UNSATISFIABLE;
  return { start, end: Math.min(last, size - 1) };
}
