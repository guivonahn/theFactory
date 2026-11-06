import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuestionState,
  currentField,
  fieldOptions,
  handleQuestionKey,
  visibleFields,
} from '../src/forms.js';

function stateFor(form) {
  return createQuestionState(form, 'ses_test');
}

test('visibleFields filters hidden fields and evaluates when predicates', () => {
  const form = {
    fields: [
      { key: 'a', type: 'string' },
      { key: 'hidden', type: 'string', hidden: true },
      { key: 'eq', type: 'string', when: { key: 'a', op: 'eq', value: 'yes' } },
      { key: 'neq', type: 'string', when: [{ key: 'a', op: 'neq', value: 'no' }] },
    ],
  };
  assert.deepEqual(visibleFields(form).map((field) => field.key), ['a', 'neq']);
  assert.deepEqual(visibleFields(form, { a: 'yes' }).map((field) => field.key), ['a', 'eq', 'neq']);
  assert.deepEqual(visibleFields(form, { a: 'no' }).map((field) => field.key), ['a']);
  assert.deepEqual(visibleFields({}).map((field) => field.key), []);
});

test('createQuestionState starts on the first field with its defaults', () => {
  const state = stateFor({
    id: 'form_1',
    title: 'Pick a name',
    fields: [{
      key: 'name',
      type: 'string',
      label: 'Name',
      options: [{ value: 'alice', label: 'Alice' }, { value: 'bob', label: 'Bob' }],
    }],
  });
  assert.equal(state.open, true);
  assert.equal(state.sessionID, 'ses_test');
  assert.equal(state.fieldIndex, 0);
  assert.equal(currentField(state).key, 'name');
  assert.equal(fieldOptions(state).length, 2);
  assert.equal(state.buffer, '');
  assert.equal(state.error, '');
});

test('arrows choose an option and Enter replies with its value', () => {
  const state = stateFor({
    fields: [{
      key: 'name',
      type: 'string',
      options: [{ value: 'alice' }, { value: 'bob' }],
    }],
  });
  assert.deepEqual(handleQuestionKey(state, '\x1b[B'), { action: 'changed' });
  assert.equal(state.optionIndex, 1);
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: { name: 'bob' } });
});

test('typing a custom answer overrides the option list', () => {
  const state = stateFor({
    fields: [{
      key: 'name',
      type: 'string',
      options: [{ value: 'alice' }, { value: 'bob' }],
    }],
  });
  for (const character of 'carol') handleQuestionKey(state, character);
  assert.equal(state.custom, true);
  assert.equal(state.optionIndex, 2, 'the custom row is selected');
  assert.equal(state.buffer, 'carol');
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: { name: 'carol' } });
});

test('required string fields reject an empty answer', () => {
  const state = stateFor({ fields: [{ key: 'why', type: 'string', required: true }] });
  const result = handleQuestionKey(state, '\r');
  assert.deepEqual(result, { action: 'changed' });
  assert.equal(state.error, 'This field is required');
  assert.equal(state.fieldIndex, 0);
});

test('boolean fields accept y/n, space, and left/right arrows', () => {
  const field = { key: 'flag', type: 'boolean', default: false };
  let state = stateFor({ fields: [field] });
  assert.equal(state.buffer, 'false');
  handleQuestionKey(state, 'y');
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: { flag: true } });

  state = stateFor({ fields: [field] });
  assert.deepEqual(handleQuestionKey(state, '\x1b[C'), { action: 'changed' });
  assert.equal(state.buffer, 'true');
  handleQuestionKey(state, ' ');
  assert.equal(state.buffer, 'false');
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: { flag: false } });
});

test('multiselect toggles with space and enforces minItems', () => {
  const state = stateFor({
    fields: [{
      key: 'langs',
      type: 'multiselect',
      required: true,
      minItems: 2,
      options: [{ value: 'js' }, { value: 'go' }, { value: 'rs' }],
    }],
  });
  handleQuestionKey(state, ' ');
  assert.deepEqual(state.selected, ['js']);
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'changed' });
  assert.equal(state.error, 'Select at least 2 options');

  handleQuestionKey(state, '\x1b[B');
  handleQuestionKey(state, ' ');
  assert.deepEqual(state.selected, ['js', 'go']);
  assert.deepEqual(handleQuestionKey(state, '\r'), {
    action: 'reply',
    answer: { langs: ['js', 'go'] },
  });
});

test('integer fields convert values and enforce min/max', () => {
  const state = stateFor({ fields: [{ key: 'count', type: 'integer', min: 1, max: 5 }] });
  handleQuestionKey(state, '9');
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'changed' });
  assert.equal(state.error, 'Must be at most 5');

  handleQuestionKey(state, '\x7f');
  handleQuestionKey(state, '3');
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: { count: 3 } });
});

test('answering a controller reveals conditional fields and values accumulate', () => {
  const state = stateFor({
    fields: [
      { key: 'mode', type: 'string', options: [{ value: 'yes' }, { value: 'no' }] },
      { key: 'detail', type: 'string', when: { key: 'mode', op: 'eq', value: 'yes' } },
    ],
  });
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'changed' });
  assert.deepEqual(state.fields.map((field) => field.key), ['mode', 'detail']);
  assert.equal(currentField(state).key, 'detail');
  for (const character of 'abc') handleQuestionKey(state, character);
  assert.deepEqual(handleQuestionKey(state, '\r'), {
    action: 'reply',
    answer: { mode: 'yes', detail: 'abc' },
  });
});

test('conditional fields stay hidden when the predicate does not match', () => {
  const state = stateFor({
    fields: [
      { key: 'mode', type: 'string', options: [{ value: 'yes' }, { value: 'no' }] },
      { key: 'detail', type: 'string', when: { key: 'mode', op: 'eq', value: 'yes' } },
    ],
  });
  handleQuestionKey(state, '\x1b[B');
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: { mode: 'no' } });
});

test('external fields expose a URL and contribute no answer', () => {
  const state = stateFor({
    fields: [{ key: 'auth', type: 'external', url: 'https://example.com/auth' }],
  });
  assert.deepEqual(handleQuestionKey(state, 'o'), {
    action: 'external',
    url: 'https://example.com/auth',
  });
  assert.deepEqual(handleQuestionKey(state, '\r'), { action: 'reply', answer: {} });
});

test('Esc cancels and closed states ignore keys', () => {
  const state = stateFor({ fields: [{ key: 'x', type: 'string' }] });
  assert.deepEqual(handleQuestionKey(state, '\x1b'), { action: 'cancel' });
  state.open = false;
  assert.equal(handleQuestionKey(state, 'a'), null);
  assert.equal(handleQuestionKey(null, '\r'), null);
});
