import test from 'node:test';
import assert from 'node:assert/strict';
import { hexDiceRules, parseHexManualCheck, resolveHexCheck } from '../../module/witcher/magic-hex-rules.js';
import { check, checkHTML } from '../../module/witcher/runtime.js';
const cursed = (...keys) => ({ effects: keys.map((key) => ({ magic: { kind: 'hex', key } })) });

test('Devil’s Luck only expands fumbles under printed conditions and respects suppression', () => {
  const state = cursed('the-devils-luck');
  assert.deepEqual(hexDiceRules(state).fumbleFaces, [1]);
  for (const context of [{ stressed: true }, { deadline: true }, { dc: 16 }])
    assert.deepEqual(hexDiceRules(state, context).fumbleFaces, [1, 2]);
  assert.deepEqual(hexDiceRules(state, { dc: 15 }).fumbleFaces, [1]);
  state.effects[0].magic.suppressed = true;
  assert.deepEqual(hexDiceRules(state, { stressed: true }).fumbleFaces, [1]);
});

test('manual Evil Eye requires two complete actual fumble chains; takes larger severity', () => {
  const rules = hexDiceRules(cursed('the-devils-luck', 'the-evil-eye'), { dc: 20 });
  const entered = parseHexManualCheck('2,5;10,3', rules);
  const result = resolveHexCheck(22, entered.dice, entered.second, rules);
  assert.equal(result.total, 9);
  assert.equal(result.fumble, 13);
  assert.deepEqual(result.dice, [2, 10, 3]);
  assert.deepEqual(result.fumbleDice, [[5], [10, 3]]);
  for (const invalid of ['2,5', '2,5;10', '2,5;11', '4;5', '1,5;3;4', '1,5;0'])
    assert.throws(() => parseHexManualCheck(invalid, rules));
  assert.deepEqual(parseHexManualCheck('10,10,3', rules), { dice: [10, 10, 3], second: undefined });
});

test('shared runtime applies both curses to automatic and manual checks and exposes both chains', async (t) => {
  const oldRoll = globalThis.Roll,
    oldGame = globalThis.game;
  t.after(() => {
    if (oldRoll) globalThis.Roll = oldRoll;
    else delete globalThis.Roll;
    if (oldGame) globalThis.game = oldGame;
    else delete globalThis.game;
  });
  const sequence = [2, 4, 10, 6];
  globalThis.Roll = class {
    static validate() {
      return true;
    }
    async evaluate() {
      this.total = sequence.shift();
      return this;
    }
  };
  globalThis.game = { combat: { started: true } };
  const actor = { system: cursed('the-devils-luck', 'the-evil-eye') };
  const automatic = await check(25, { actor });
  assert.equal(automatic.total, 9);
  assert.equal(automatic.fumble, 16);
  assert.equal(sequence.length, 0);
  const manual = await check(25, { actor, manualDice: '2,4;10,6' });
  assert.equal(manual.total, automatic.total);
  assert.equal(manual.source, 'manual');
  assert.match(checkHTML(manual), /4 \/ 10, 6.*worse/);
});

import {
  hexRestPlan,
  hexPassiveModifiers,
  hexCriticalWound,
  hexTreatmentModifier,
} from '../../module/witcher/magic-hex-rules.js';
import { WOUNDS } from '../../module/witcher/wounds.js';
test('Nightmare failure blocks nightly recovery, third failure halves STA; success clears its penalties', () => {
  const state = cursed('the-nightmare');
  state.effects[0].id = 'night';
  state.effects[0].magic.castingTotal = 18;
  for (let n = 1; n <= 3; n++) {
    const plan = hexRestPlan(state, { nightmareTotals: { night: 18 } });
    assert.equal(plan.recoveryAllowed, false);
    assert.equal(plan.nights[0].nightsFailed, n);
    state.effects = plan.effects;
  }
  assert.deepEqual(hexPassiveModifiers(state), { allActions: -2, staMultiplier: 0.5 });
  const recovered = hexRestPlan(state, { nightmareTotals: { night: 19 } });
  assert.equal(recovered.recoveryAllowed, true);
  assert.deepEqual(hexPassiveModifiers({ effects: recovered.effects }), {});
});
test('Unending Need requires ten uninterrupted hours and five meals; next-day STA penalty expires', () => {
  const state = cursed('unending-need');
  const plan = hexRestPlan(state, { sleepHours: 9, meals: 4, time: 100 });
  const next = { effects: plan.effects };
  assert.deepEqual(hexPassiveModifiers(next, 101), { allActions: -3, staMultiplier: 0.5 });
  assert.deepEqual(hexPassiveModifiers(next, 86500), { allActions: -3 });
  assert.deepEqual(
    hexPassiveModifiers(
      { effects: hexRestPlan(next, { sleepHours: 10, meals: 5, time: 86501 }).effects },
      86501
    ),
    {}
  );
});
test('Bones of Glass replaces exactly four printed injuries, keeps location, and penalizes medicine while active', () => {
  const state = cursed('bones-of-glass');
  for (const [level, index, expected] of [
    ['simple', 3, 'Broken Ribs'],
    ['complex', 0, 'Compound Leg Fracture'],
    ['complex', 1, 'Compound Arm Fracture'],
    ['complex', 5, 'Skull Fracture'],
  ]) {
    const wound = hexCriticalWound(state, { ...WOUNDS[level][index], location: 'customWing' }, WOUNDS);
    assert.equal(wound.name, expected);
    assert.equal(wound.location, 'customWing');
    assert.equal(hexTreatmentModifier(state, wound), -3);
    assert.equal(hexTreatmentModifier({}, wound), 0);
  }
  const unaffected = WOUNDS.simple[0];
  assert.equal(hexCriticalWound(state, unaffected, WOUNDS), unaffected);
  state.effects[0].magic.suppressed = true;
  assert.equal(hexCriticalWound(state, WOUNDS.simple[3], WOUNDS), WOUNDS.simple[3]);
});
