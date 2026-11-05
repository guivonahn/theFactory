/**
 * Tiny raw-mode line editor for the task prompt. Append/backspace only, which
 * is all the task composer needs and keeps the custom block cursor simple.
 */

export class LineInput {
  constructor(initial = '') {
    this.value = initial;
  }

  /** Feed a raw stdin chunk and return semantic actions. */
  handle(chunk) {
    const text = String(chunk ?? '');
    const actions = [];
    if (!text) return actions;

    if (text === '\x1b') {
      actions.push({ type: 'abort' });
      return actions;
    }
    // Ignore arrow/function-key escape sequences.
    if (text.startsWith('\x1b[') || text.startsWith('\x1bO')) return actions;

    for (const char of Array.from(text)) {
      if (char === '\u0003') {
        actions.push({ type: 'quit' });
        break;
      }
      if (char === '\r' || char === '\n') {
        actions.push({ type: 'submit', value: this.value });
        break;
      }
      if (char === '\u007f' || char === '\b') {
        this.value = Array.from(this.value).slice(0, -1).join('');
        actions.push({ type: 'changed' });
        continue;
      }
      if (char === 'q' && text.length === 1 && this.value === '') {
        actions.push({ type: 'quit' });
        break;
      }
      if (char >= ' ') {
        this.value += char;
        actions.push({ type: 'changed' });
      }
    }
    return actions;
  }

  reset() {
    this.value = '';
  }

  setValue(value) {
    this.value = String(value ?? '');
  }
}
