import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManualCheck } from '../../module/witcher/rules.js';
import { check, checkHTML, prompt, validateManualCheck } from '../../module/witcher/runtime.js';

test('manual checks accept complete d10 chains and reject malformed or incomplete input', () => {
  for (const input of [undefined, null, '', '  ']) assert.equal(parseManualCheck(input), null);
  for (const [input, dice] of [
    ['7', [7]],
    [' 10, 10, 6 ', [10, 10, 6]],
    ['1,10,4', [1, 10, 4]],
    ['1,1', [1, 1]],
    ['10,1', [10, 1]],
  ])
    assert.deepEqual(parseManualCheck(input), dice);
  for (const input of [
    '0',
    '11',
    '-1',
    '2.5',
    '1e1',
    '0xA',
    '07',
    '+7',
    '1d10',
    '<b>7</b>',
    '7,',
    ',7',
    '10,,7',
    '7,6',
    '1',
    '10',
    '10,10',
    '1,10',
    '10,6,3',
    '1,4,3',
    [7],
    7,
    {},
  ])
    assert.throws(() => parseManualCheck(input), undefined, String(input));
});

test('manual check uses Witcher critical/fumble math without generating random dice', async () => {
  for (const [input, base, total, fumble, critical] of [
    ['7', 12, 19, 0, false],
    ['10,10,6', 12, 38, 0, true],
    ['1,4', 12, 8, 4, false],
    ['1,10,4', 12, 0, 14, false],
    ['10,1', 12, 23, 0, true],
    ['1,1', 12, 11, 1, false],
  ]) {
    // No Roll global is installed: an accidental automatic roll fails this test.
    const result = await check(base, { manualDice: input });
    assert.equal(result.total, total);
    assert.equal(result.fumble, fumble);
    assert.equal(result.critical, critical);
    assert.equal(result.source, 'manual');
    assert.deepEqual(result.rolls, []);
    assert.match(checkHTML(result), /manual entry/);
  }
});

test('invalid manual input leaves the dialog open for correction; cancel skips validation', async (t) => {
  const names = ['Dialog', 'FormData', 'ui'];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  let dialog,
    submissions = 0;
  const notices = [],
    values = { manualDice: '10', modifier: '3', luck: '2' };
  const form = { reportValidity: () => true, querySelectorAll: () => [] };
  globalThis.FormData = class {
    constructor() {
      return Object.entries(values);
    }
  };
  globalThis.ui = { notifications: { error: (message) => notices.push(message) } };
  globalThis.Dialog = class {
    constructor(data) {
      this.data = data;
      this.element = { querySelector: () => form };
      dialog = this;
    }
    render() {
      return this;
    }
    async submit(button) {
      submissions++;
      button.callback(this.element);
      this.data.close();
    }
  };
  const pending = prompt('Check', '', { validate: validateManualCheck });
  await dialog.submit(dialog.data.buttons.submit);
  assert.equal(submissions, 0);
  assert.equal(notices.length, 1);
  assert.equal(values.manualDice, '10');
  values.manualDice = '10,7';
  await dialog.submit(dialog.data.buttons.submit);
  assert.deepEqual(await pending, values);
  assert.equal(submissions, 1);

  values.manualDice = '1';
  const canceled = prompt('Check', '', { validate: validateManualCheck });
  await dialog.submit(dialog.data.buttons.cancel);
  assert.equal(await canceled, null);
  assert.equal(notices.length, 1);
});
