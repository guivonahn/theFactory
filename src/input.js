/**
 * Multiline task composer with bracketed-paste support.
 *
 * Full buffer (`value`) is separate from the visible viewport (cursor/scroll).
 * Bracketed paste (`\x1b[200~` … `\x1b[201~`) is inserted verbatim — newlines
 * do not submit. Large pastes are bulk-inserted (single concat), never
 * per-character so 50k-line pastes do not freeze. No length cap.
 *
 * Keys: Enter submits, Backspace deletes, Left/Right/Up/Down/Home/End move
 * cursor, Ctrl-C quits, Esc aborts, bare `q` on empty quits (unchanged).
 */

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function longestSuffixPrefix(a, b) {
  const max = Math.min(a.length, b.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (a.endsWith(b.slice(0, n))) return n;
  }
  return 0;
}

export class LineInput {
  constructor(initial = '') {
    this.value = String(initial ?? '');
    this.cursor = Array.from(this.value).length; // code-point offset
    this.scroll = 0; // first visible line (viewport)
    this.pasting = false;
    this.pasteHold = ''; // partial escape split across chunks
    this.cursorCol = 0;
  }

  /** Code-point length without O(n) spread on every read. */
  get length() { return Array.from(this.value).length; }

  /** All lines of the full buffer (split on \n, keeps \r stripped). */
  lines() {
    return this.value.split('\n').map((l) => l.replace(/\r$/, ''));
  }

  /** Cursor line index (0-based). */
  cursorLine() {
    const upto = Array.from(this.value).slice(0, this.cursor).join('');
    return (upto.match(/\n/g) ?? []).length;
  }

  /** Cursor column within its line. */
  cursorColumn() {
    const cps = Array.from(this.value).slice(0, this.cursor);
    const idx = cps.lastIndexOf('\n');
    return idx < 0 ? cps.length : cps.length - idx - 1;
  }

  /** Viewport window of `visible` lines ending at cursor. Returns {lines, offset}. */
  viewport(visible = 1) {
    const all = this.lines();
    const cur = this.cursorLine();
    let offset = Math.max(0, Math.min(cur, all.length - Math.max(1, visible)));
    if (this.scroll > offset) offset = this.scroll;
    const end = Math.min(all.length, offset + Math.max(1, visible));
    offset = Math.max(0, Math.min(offset, Math.max(0, all.length - (end - offset))));
    return { lines: all.slice(offset, end), offset };
  }

  /** Paste collapsed label like opencode: `[pasted n lines]`. */
  pasteLabel(text) {
    const n = String(text ?? '').split('\n').length;
    return `[pasted ${n} line${n === 1 ? '' : 's'}]`;
  }

  /** Insert `text` at cursor verbatim (bulk — one concat). */
  insertText(text) {
    const cps = Array.from(this.value);
    const before = cps.slice(0, this.cursor).join('');
    const after = cps.slice(this.cursor).join('');
    this.value = before + String(text) + after;
    this.cursor = Array.from(before).length + Array.from(String(text)).length;
  }

  /** Feed a raw stdin chunk and return semantic actions. */
  handle(chunk) {
    let text = this.pasteHold + String(chunk ?? '');
    this.pasteHold = '';
    const actions = [];
    if (!text) return actions;

    // Split handling: trailing partial `\x1b[20` etc. that may complete
    // `\x1b[200~` in the next chunk.
    if (!this.pasting) {
      const partial = longestSuffixPrefix(text, PASTE_START);
      if (partial >= 3) {
        // Check if the suffix is a live prefix of PASTE_START and chunk ended mid-escape.
        const tail = text.slice(-partial);
        if (PASTE_START.startsWith(tail)) {
          this.pasteHold = tail;
          text = text.slice(0, -partial);
          if (!text) return actions;
        }
      }
    }

    let i = 0;
    // Heuristic for terminals without bracketed paste: a chunk that contains a
    // newline but is more than a bare Enter is almost certainly a paste, so
    // keep the newline as literal text instead of submitting.
    const isEnter = text === '\r' || text === '\n' || text === '\r\n';
    const pasteLike = !isEnter && text.length > 1 && (text.includes('\n') || text.includes('\r'));
    while (i < text.length) {
      if (this.pasting) {
        const endAt = text.indexOf(PASTE_END, i);
        if (endAt === -1) {
          // Accumulate rest; hold a trailing partial end-marker.
          const partial = longestSuffixPrefix(text.slice(i), PASTE_END);
          const keep = partial >= 3 ? partial : 0;
          const bodyEnd = keep ? text.length - keep : text.length;
          if (bodyEnd > i) {
            const body = text.slice(i, bodyEnd).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            this.value += body;
            this.cursor = Array.from(this.value).length;
            actions.push({ type: 'pasted', lines: body.split('\n').length });
          }
          this.pasteHold = keep ? text.slice(-keep) : '';
          i = text.length;
          break;
        }
        const body = text.slice(i, endAt).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        this.value += body;
        this.cursor = Array.from(this.value).length;
        actions.push({ type: 'pasted', lines: body.split('\n').length });
        this.pasting = false;
        i = endAt + PASTE_END.length;
        continue;
      }

      if (text.startsWith(PASTE_START, i)) {
        this.pasting = true;
        i += PASTE_START.length;
        continue;
      }
      // Any other escape sequence (arrows, etc.) or bare Esc.
      if (text[i] === '\x1b') {
        if (text.length === 1 && i === 0) {
          actions.push({ type: 'abort' });
          return actions;
        }
        if (text.startsWith('\x1b[A', i)) { this.moveLines(-1); i += 3; continue; }
        if (text.startsWith('\x1b[B', i)) { this.moveLines(1); i += 3; continue; }
        if (text.startsWith('\x1b[C', i)) { this.moveCols(1); i += 3; continue; }
        if (text.startsWith('\x1b[D', i)) { this.moveCols(-1); i += 3; continue; }
        if (text.startsWith('\x1b[H', i)) { this.moveHome(); i += 2; continue; }
        if (text.startsWith('\x1b[F', i)) { this.moveEnd(); i += 2; continue; }
        if (text.startsWith('\x1bOH', i) || text.startsWith('\x1bOF', i)) { i += 3; continue; }
        if (text.startsWith('\x1b[200~', i) || text.startsWith('\x1b[201~', i)) { i += 6; continue; }
        // Unknown escape: swallow `\x1b[...` so paste markers never leak.
        const m = text.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z~]/);
        if (m) { actions.push({ type: 'escape' }); i += m[0].length; continue; }
        i += 1;
        continue;
      }

      const char = String.fromCodePoint(text.codePointAt(i));
      const next = i + char.length;
      if (char === '\u0003') {
        actions.push({ type: 'quit' });
        break;
      }
      if (char === '\r' || char === '\n') {
        if (pasteLike) {
          this.insertText(char === '\r' ? '\n' : char);
          actions.push({ type: 'changed' });
          i = next;
          continue;
        }
        actions.push({ type: 'submit', value: this.value });
        i = next;
        break;
      }
      if (char === '\u007f' || char === '\b') {
        if (this.cursor > 0) {
          const cps = Array.from(this.value);
          cps.splice(this.cursor - 1, 1);
          this.value = cps.join('');
          this.cursor -= 1;
          actions.push({ type: 'changed' });
        }
        i = next;
        continue;
      }
      if (char === 'q' && text.length === 1 && this.value === '') {
        actions.push({ type: 'quit' });
        i = next;
        break;
      }
      if (char >= ' ' || char === '\t') {
        this.insertText(char);
        actions.push({ type: 'changed' });
        i = next;
        continue;
      }
      // Other control chars ignored (preserves existing behavior); tabs/space kept.
      i = next;
    }
    // Keep scroll following cursor viewport.
    if (actions.length) this.scroll = Math.max(0, this.cursorLine());
    return actions;
  }

  moveCols(delta) {
    const cps = Array.from(this.value);
    this.cursor = Math.max(0, Math.min(cps.length, this.cursor + (delta < 0 ? -1 : 1)));
    this.scroll = Math.max(0, this.cursorLine());
  }

  moveHome() {
    const cps = Array.from(this.value);
    let idx = this.cursor;
    while (idx > 0 && cps[idx - 1] !== '\n') idx -= 1;
    this.cursor = idx;
    this.scroll = this.cursorLine();
  }

  moveEnd() {
    const cps = Array.from(this.value);
    let idx = this.cursor;
    while (idx < cps.length && cps[idx] !== '\n') idx += 1;
    this.cursor = idx;
    this.scroll = this.cursorLine();
  }

  moveLines(delta) {
    const lines = this.lines();
    const curLine = this.cursorLine();
    const curCol = Math.min(this.cursorColumn(), (lines[curLine]?.length ?? 0));
    const target = Math.max(0, Math.min(lines.length - 1, curLine + (delta < 0 ? -1 : 1)));
    // Recompute cursor code-point offset for target line + curCol.
    let remaining = lines.slice(0, target).join('\n').length;
    if (target > 0) remaining += target; // newlines become code points 1:1 here
    const cps = Array.from(lines.slice(0, target).join('\n') + (target ? '\n' : ''));
    this.cursor = cps.length + Math.min(Array.from(lines[target] ?? '').length, curCol);
    void remaining;
    this.scroll = this.cursorLine();
  }

  reset() {
    this.value = '';
    this.cursor = 0;
    this.scroll = 0;
    this.pasting = false;
    this.pasteHold = '';
  }

  setValue(value) {
    this.value = String(value ?? '');
    this.cursor = Array.from(this.value).length;
    this.scroll = this.cursorLine();
  }
}
