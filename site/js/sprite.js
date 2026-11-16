// The placeholder for a game with no screenshot: a small mirrored pixel figure
// drawn from the game's name, so a shelf of untested games is still a shelf of
// different cards and each game keeps its figure from visit to visit.

export const SVG = 'http://www.w3.org/2000/svg';
const COLS = 7;
const ROWS = 7;

// FNV-1a, then a xorshift generator: small, and the same in every browser.
function generator(text) {
  let state = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) state = Math.imul(state ^ text.charCodeAt(i), 0x01000193);
  state = state >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function sprite(seed) {
  const random = generator(String(seed));
  const half = Math.ceil(COLS / 2);
  let body = '';
  let eyes = '';
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < half; x++) {
      // Denser towards the middle column, so the figures read as creatures
      // rather than noise.
      const on = random() < 0.34 + 0.16 * x;
      const eye = on && y > 0 && y < 4 && x > 0 && x < half - 1 && random() < 0.22;
      for (const column of x === COLS - 1 - x ? [x] : [x, COLS - 1 - x]) {
        if (eye) eyes += `M${column} ${y}h1v1h-1z`;
        else if (on) body += `M${column} ${y}h1v1h-1z`;
      }
    }
  }
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${COLS} ${ROWS}`);
  svg.setAttribute('class', 'sprite');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('shape-rendering', 'crispEdges');
  // The N-Gage screen shows 4096 colours; the figures stay within a few muted
  // ones so that a real screenshot is always the brighter thing on the page.
  svg.style.setProperty('--hue', String(Math.floor(random() * 12) * 30));
  for (const [name, d] of [['sprite-body', body], ['sprite-eyes', eyes]]) {
    if (!d) continue;
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('class', name);
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
