/**
 * Small offscreen character/colour grid with a diff-based ANSI flush.
 * Coordinates are zero-based; ANSI output is converted to one-based rows/cols.
 */

import { fgCode, supportsTruecolor } from './colors.js';

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\u0007]*(?:\u0007|\x1b\\)/g;
const PLAIN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const CONTINUATION = '\u0000';

/** Remove ANSI escapes and non-printing control characters from untrusted text. */
export function stripAnsi(value) {
  return String(value ?? '')
    .replace(OSC_PATTERN, '')
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(PLAIN_CONTROL, '');
}

/** East Asian Wide / Fullwidth ranges (wcwidth-lite). */
export function isWide(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
  );
}

/** Display cells for one code point (combining marks are treated as width 1). */
export function charWidth(value) {
  const char = Array.from(String(value ?? ''))[0];
  if (!char) return 0;
  return isWide(char.codePointAt(0)) ? 2 : 1;
}

/** Display width of a string after ANSI/control stripping. */
export function displayWidth(value) {
  let width = 0;
  for (const char of Array.from(stripAnsi(value))) {
    if (char === '\n') continue;
    width += charWidth(char);
  }
  return width;
}

function splitByWidth(word, max) {
  const chunks = [];
  let chunk = '';
  let used = 0;
  for (const char of Array.from(word)) {
    const cells = charWidth(char);
    if (cells > max) {
      if (chunk) {
        chunks.push(chunk);
        chunk = '';
        used = 0;
      }
      chunks.push('…');
      continue;
    }
    if (used + cells > max && chunk) {
      chunks.push(chunk);
      chunk = '';
      used = 0;
    }
    chunk += char;
    used += cells;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Greedy word-wrap that hard-splits overlong words by display cells. */
export function wrapText(value, width) {
  const max = Math.max(1, Math.floor(width));
  const lines = [];
  for (const paragraph of stripAnsi(value).split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const word of words) {
      const wordWidth = displayWidth(word);
      if (lineWidth === 0) {
        if (wordWidth <= max) {
          line = word;
          lineWidth = wordWidth;
        } else {
          const chunks = splitByWidth(word, max);
          for (let index = 0; index < chunks.length - 1; index += 1) lines.push(chunks[index]);
          line = chunks[chunks.length - 1] ?? '';
          lineWidth = displayWidth(line);
        }
        continue;
      }
      if (lineWidth + 1 + wordWidth <= max) {
        line += ` ${word}`;
        lineWidth += 1 + wordWidth;
        continue;
      }
      lines.push(line);
      if (wordWidth <= max) {
        line = word;
        lineWidth = wordWidth;
      } else {
        const chunks = splitByWidth(word, max);
        for (let index = 0; index < chunks.length - 1; index += 1) lines.push(chunks[index]);
        line = chunks[chunks.length - 1] ?? '';
        lineWidth = displayWidth(line);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Truncate text to a display-cell width, appending an ellipsis when needed. */
export function truncate(value, width) {
  const text = stripAnsi(value).replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  if (width === 1) return '…';
  const output = [];
  let used = 0;
  for (const char of Array.from(text)) {
    const cells = charWidth(char);
    if (used + cells > width - 1) break;
    output.push(char);
    used += cells;
  }
  return `${output.join('')}…`;
}

/** Keep the visible tail of a string within a display-cell budget. */
export function tailByWidth(value, width) {
  const text = stripAnsi(value).replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  if (width === 1) return '…';
  const output = [];
  let used = 0;
  for (const char of Array.from(text).reverse()) {
    const cells = charWidth(char);
    if (used + cells > width - 1) break;
    output.unshift(char);
    used += cells;
  }
  return `…${output.join('')}`;
}

function makeBuffer(width, height, sentinel) {
  const chars = Array.from({ length: height }, () => new Array(width).fill(sentinel ? '\u0000' : ' '));
  const styles = Array.from({ length: height }, () => new Array(width).fill(sentinel ? -1 : 0));
  return { chars, styles };
}

export class Canvas {
  /**
   * @param {number} width columns
   * @param {number} height rows
   * @param {{color?: boolean}} [options]
   */
  constructor(width, height, options = {}) {
    this.color = options.color !== false;
    this.truecolor = options.truecolor ?? supportsTruecolor();
    // Cached ANSI code per unique style so flush() doesn't resolve every cell.
    this._styleCache = new Map();
    this.resize(width, height);
  }

  /** Cached, truecolor-aware SGR sequence for one style value. */
  _styleCode(style) {
    const key = `${typeof style}:${style}:${this.truecolor ? 1 : 0}`;
    let code = this._styleCache.get(key);
    if (code === undefined) {
      code = fgCode(style, { truecolor: this.truecolor });
      this._styleCache.set(key, code);
    }
    return code;
  }

  /** Allocate two buffers and force the next flush to paint every cell. */
  resize(width, height) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this._buffers = [makeBuffer(this.width, this.height, false), makeBuffer(this.width, this.height, false)];
    this._back = 0;
    this._front = 1;
    this._buffers[this._front] = makeBuffer(this.width, this.height, true);
    this._clearBack();
  }

  _clearBack() {
    const buffer = this._buffers[this._back];
    for (let row = 0; row < this.height; row += 1) {
      buffer.chars[row].fill(' ');
      buffer.styles[row].fill(0);
    }
  }

  /** Start a new frame on the back buffer. */
  clear() {
    this._clearBack();
  }

  /** Place one glyph, silently ignoring out-of-bounds writes. */
  put(row, col, glyph, style = 0) {
    // Hex-string styles ('#RRGGBB') must survive verbatim; numbers stay numbers.
    const normStyle = typeof style === 'string' ? style : (style | 0);
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) return;
    const buffer = this._buffers[this._back];
    let char = Array.from(stripAnsi(glyph))[0] ?? ' ';
    let cells = charWidth(char);
    if (cells === 2 && col + 1 >= this.width) {
      char = ' ';
      cells = 1;
    }
    // Replacing half of an existing wide glyph must remove the other half.
    if (col > 0 && buffer.chars[row][col - 1] !== CONTINUATION && charWidth(buffer.chars[row][col - 1]) === 2) {
      buffer.chars[row][col - 1] = ' ';
    }
    if (buffer.chars[row][col] === CONTINUATION && col > 0 && charWidth(buffer.chars[row][col - 1]) === 2) {
      buffer.chars[row][col - 1] = ' ';
    }
    if (cells === 1 && buffer.chars[row][col + 1] === CONTINUATION) {
      buffer.chars[row][col + 1] = ' ';
      buffer.styles[row][col + 1] = 0;
    }
    buffer.chars[row][col] = char;
    buffer.styles[row][col] = normStyle;
    if (cells === 2) {
      buffer.chars[row][col + 1] = CONTINUATION;
      buffer.styles[row][col + 1] = normStyle;
    }
  }

  /** Write a string and return the next free column. */
  write(row, col, value, style = 0) {
    const text = stripAnsi(value);
    let cursor = col;
    for (const char of Array.from(text)) {
      if (char === '\n') break;
      const cells = charWidth(char);
      if (cursor + cells > this.width) break;
      this.put(row, cursor, char, style);
      cursor += cells;
    }
    return cursor;
  }

  /** Fill a rectangle with one glyph (used for clearing panels). */
  fill(row, col, width, height, glyph = ' ', style = 0) {
    for (let r = row; r < row + height; r += 1) {
      for (let c = col; c < col + width; c += 1) this.put(r, c, glyph, style);
    }
  }

  /** Draw a single-line box, optionally with a title embedded in the top edge. */
  box(row, col, width, height, style = 0, title = '') {
    if (width < 2 || height < 2) return;
    const right = col + width - 1;
    const bottom = row + height - 1;
    for (let c = col + 1; c < right; c += 1) {
      this.put(row, c, '─', style);
      this.put(bottom, c, '─', style);
    }
    for (let r = row + 1; r < bottom; r += 1) {
      this.put(r, col, '│', style);
      this.put(r, right, '│', style);
    }
    this.put(row, col, '┌', style);
    this.put(row, right, '┐', style);
    this.put(bottom, col, '└', style);
    this.put(bottom, right, '┘', style);

    const label = truncate(title, width - 4);
    if (label) {
      const start = col + Math.max(2, Math.floor((width - label.length - 2) / 2));
      this.write(row, start, ` ${label} `, style);
    }
  }

  /** Compose the ANSI diff between the back buffer and the last flushed frame. */
  flush() {
    const back = this._buffers[this._back];
    const front = this._buffers[this._front];
    const chunks = [];
    let activeStyle = 0;

    for (let row = 0; row < this.height; row += 1) {
      let col = 0;
      while (col < this.width) {
        const changed =
          back.chars[row][col] !== front.chars[row][col] || back.styles[row][col] !== front.styles[row][col];
        if (!changed) {
          col += 1;
          continue;
        }
        chunks.push(`\x1b[${row + 1};${col + 1}H`);
        while (col < this.width) {
          const same =
            back.chars[row][col] === front.chars[row][col] && back.styles[row][col] === front.styles[row][col];
          if (same) break;
          const style = back.styles[row][col];
          if (this.color && style !== activeStyle) {
            chunks.push(this._styleCode(style));
            activeStyle = style;
          }
          chunks.push(back.chars[row][col]);
          col += 1;
        }
      }
    }

    if (this.color && activeStyle !== 0) chunks.push('\x1b[0m');

    const nextFront = this._back;
    this._back = this._front;
    this._front = nextFront;
    return chunks.join('');
  }

  /** Render the current back buffer as plain, style-free text for pipes/snapshots. */
  toPlainText() {
    const buffer = this._buffers[this._back];
    return buffer.chars
      .map((row) => row.join('').replace(/\s+$/u, ''))
      .join('\n');
  }
}
