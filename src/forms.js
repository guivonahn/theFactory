/**
 * Pure state helpers for OpenCode question forms. The TUI owns rendering and
 * transport; this module only interprets keys and builds reply values.
 */

function fieldsOf(form) {
  return Array.isArray(form?.fields) ? form.fields.filter((field) => field && typeof field === 'object') : [];
}

function conditionMet(condition, answers) {
  if (!condition || typeof condition !== 'object') return true;
  const actual = answers?.[condition.key];
  if (condition.op === 'eq') return actual === condition.value;
  if (condition.op === 'neq') return actual !== condition.value;
  return true;
}

/** Filter hidden fields and fields whose `when` predicates do not match. */
export function visibleFields(form, answers = {}) {
  return fieldsOf(form).filter((field) => {
    if (field.hidden) return false;
    if (field.when == null) return true;
    const conditions = Array.isArray(field.when) ? field.when : [field.when];
    return conditions.every((condition) => conditionMet(condition, answers));
  });
}

function optionsOf(field) {
  return Array.isArray(field?.options)
    ? field.options.filter((option) => option && typeof option === 'object')
    : [];
}

function hasCustomRow(field) {
  return optionsOf(field).length > 0 && (field?.custom === true || field?.type === 'string');
}

function resetInput(state, field) {
  state.buffer = '';
  state.custom = false;
  state.optionIndex = 0;
  state.selected = [];
  state.error = '';
  if (!field) return;

  if (field.type === 'boolean') {
    state.buffer = field.default === true || field.default === 'true' ? 'true' : 'false';
    return;
  }
  if (field.type === 'multiselect') {
    state.selected = Array.isArray(field.default) ? [...field.default] : [];
  }
  if (field.default != null && ['string', 'number', 'integer'].includes(field.type)) {
    state.buffer = String(field.default);
  }

  const options = optionsOf(field);
  if (options.length > 0) {
    const defaultIndex = options.findIndex((option) => option.value === field.default);
    if (defaultIndex >= 0) state.optionIndex = defaultIndex;
    else if (field.default != null && hasCustomRow(field)) {
      state.optionIndex = options.length;
      state.custom = true;
    }
  }
}

/** Create mutable popup state for one pending form. */
export function createQuestionState(form, sessionID) {
  const state = {
    open: true,
    sessionID,
    form,
    fields: visibleFields(form),
    fieldIndex: 0,
    optionIndex: 0,
    answers: {},
    buffer: '',
    custom: false,
    error: '',
    // Current multiselect values, staged separately until Enter commits them.
    selected: [],
  };
  resetInput(state, state.fields[0]);
  return state;
}

export function currentField(state) {
  return state?.fields?.[state.fieldIndex] ?? null;
}

export function fieldOptions(state) {
  return optionsOf(currentField(state));
}

function changed(state) {
  state.error = '';
  return { action: 'changed' };
}

function fail(state, message) {
  state.error = message;
  return { action: 'changed' };
}

function moveOption(state, direction) {
  const field = currentField(state);
  const options = optionsOf(field);
  if (options.length === 0) return null;
  const rows = options.length + (hasCustomRow(field) ? 1 : 0);
  state.optionIndex = Math.max(0, Math.min(rows - 1, state.optionIndex + direction));
  state.custom = hasCustomRow(field) && state.optionIndex === options.length;
  return changed(state);
}

function appendPrintable(state, text) {
  const field = currentField(state);
  if (!field) return null;
  if (field.type === 'boolean') {
    if (text === 'y' || text === 'Y') state.buffer = 'true';
    else if (text === 'n' || text === 'N') state.buffer = 'false';
    else if (text === ' ') state.buffer = state.buffer === 'true' ? 'false' : 'true';
    else return null;
    return changed(state);
  }
  if (!['string', 'number', 'integer'].includes(field.type)) return null;
  if (optionsOf(field).length > 0) {
    state.custom = true;
    if (hasCustomRow(field)) state.optionIndex = optionsOf(field).length;
  }
  state.buffer += text;
  return changed(state);
}

function backspace(state) {
  const field = currentField(state);
  if (!field || !['string', 'number', 'integer'].includes(field.type)) return null;
  state.buffer = Array.from(state.buffer).slice(0, -1).join('');
  if (!state.buffer) {
    state.custom = false;
    const count = optionsOf(field).length;
    if (count > 0 && state.optionIndex >= count) state.optionIndex = count - 1;
  }
  return changed(state);
}

function toggleMultiselect(state) {
  const field = currentField(state);
  if (field?.type !== 'multiselect') return null;
  const option = optionsOf(field)[state.optionIndex];
  if (!option) return null;
  const index = state.selected.indexOf(option.value);
  if (index >= 0) state.selected.splice(index, 1);
  else state.selected.push(option.value);
  return changed(state);
}

function numberValue(state, field, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: field.required ? 'This field is required' : 'Enter a number' };
  const value = field.type === 'integer' ? Number.parseInt(text, 10) : Number(text);
  if (!Number.isFinite(value)) return { error: field.type === 'integer' ? 'Enter an integer' : 'Enter a number' };
  if (field.min != null && value < Number(field.min)) return { error: `Must be at least ${field.min}` };
  if (field.max != null && value > Number(field.max)) return { error: `Must be at most ${field.max}` };
  return { value };
}

function answerForCurrentField(state, field) {
  const options = optionsOf(field);
  if (field.type === 'multiselect') {
    const minimum = Number(field.minItems ?? (field.required ? 1 : 0));
    if (state.selected.length < minimum) {
      return { error: minimum === 1 ? 'Select at least one option' : `Select at least ${minimum} options` };
    }
    return { value: [...state.selected], skip: false };
  }
  if (field.type === 'boolean') return { value: state.buffer === 'true', skip: false };

  let raw = state.buffer;
  if (options.length > 0 && !state.custom) raw = options[state.optionIndex]?.value;
  if (field.type === 'number' || field.type === 'integer') {
    const converted = numberValue(state, field, raw);
    return converted.error ? converted : { ...converted, skip: false };
  }

  const customOption = options.length > 0 && state.custom;
  const value = customOption ? String(raw ?? '').trim() : raw;
  if (field.required && String(value ?? '').trim() === '') return { error: 'This field is required' };
  if (field.min != null && String(value ?? '').length < Number(field.min)) {
    return { error: `Must be at least ${field.min} characters` };
  }
  if (field.max != null && String(value ?? '').length > Number(field.max)) {
    return { error: `Must be at most ${field.max} characters` };
  }
  return { value, skip: false };
}

function commitAndAdvance(state) {
  const field = currentField(state);
  if (!field) return null;
  if (field.type === 'external') {
    // External fields collect no reply value; Enter simply advances.
  } else {
    const result = answerForCurrentField(state, field);
    if (result.error) return fail(state, result.error);
    if (!result.skip && field.key != null) state.answers[field.key] = result.value;
  }

  const originalFields = fieldsOf(state.form);
  const originalIndex = originalFields.indexOf(field);
  state.fields = visibleFields(state.form, state.answers);
  let nextIndex = -1;
  for (let index = 0; index < state.fields.length; index += 1) {
    if (originalFields.indexOf(state.fields[index]) > originalIndex) {
      nextIndex = index;
      break;
    }
  }
  state.error = '';
  if (nextIndex < 0) {
    state.fieldIndex = state.fields.length;
    resetInput(state, null);
    return { action: 'reply', answer: { ...state.answers } };
  }
  state.fieldIndex = nextIndex;
  resetInput(state, state.fields[nextIndex]);
  return { action: 'changed' };
}

/**
 * Apply one raw stdin chunk. Escape sequences other than the supported arrows
 * are ignored. Multi-character printable chunks (for example paste) append in
 * order; Enter returns the final reply action as soon as the last field commits.
 */
export function handleQuestionKey(state, chunk) {
  if (!state?.open || !currentField(state)) return null;
  const text = String(chunk ?? '');
  if (text === '\x1b') return { action: 'cancel' };
  if (text === '\x1b[A') return moveOption(state, -1);
  if (text === '\x1b[B') return moveOption(state, 1);
  if (text === '\x1b[D' || text === '\x1b[C') {
    const field = currentField(state);
    if (field?.type !== 'boolean') return null;
    state.buffer = text === '\x1b[C' ? 'true' : 'false';
    return changed(state);
  }
  if (text.startsWith('\x1b')) return null;

  const field = currentField(state);
  if (field?.type === 'external' && (text === 'o' || text === 'O')) {
    const url = field.url ?? field.uri ?? field.href ?? field.default;
    return typeof url === 'string' && url ? { action: 'external', url } : null;
  }

  let result = null;
  for (const character of text) {
    if (character === '\r' || character === '\n') return commitAndAdvance(state);
    if (character === '\x7f' || character === '\b') {
      result = backspace(state) ?? result;
      continue;
    }
    if (character === ' ' && currentField(state)?.type === 'multiselect') {
      result = toggleMultiselect(state) ?? result;
      continue;
    }
    if (character.codePointAt(0) < 32 || character === '\x7f') continue;
    result = appendPrintable(state, character) ?? result;
  }
  return result;
}
