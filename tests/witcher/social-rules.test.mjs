import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOCIAL_ATTACKS,
  SOCIAL_DEFENSES,
  SOCIAL_CONVENTIONS,
  socialDamage,
  socialMove,
  socialModifiers,
  initialResolve,
  validateSocialConventions,
  verbalDefenseResult,
  cumulativeDamage,
} from '../../module/witcher/social-rules.js';
const conventions = Object.fromEntries(
  Object.entries(SOCIAL_CONVENTIONS).map(([key, choices]) => [key, choices[0]])
);
const actor = { uuid: 'A', system: { stats: { emp: 2, int: 8, will: 9 }, social: { relationships: [] } } };
const target = { uuid: 'B', system: { stats: { emp: 6, int: 4, will: 7 }, social: { relationships: [] } } };
const encounter = () => ({
  conventions: { ...conventions },
  effects: [],
  counters: {},
  torture: [],
  turnSerial: 0,
});

test('every printed move has its correct damage attribute independently from the skill attribute', () => {
  assert.equal(socialDamage(SOCIAL_ATTACKS.deceive, actor, 3), 11);
  assert.equal(socialDamage(SOCIAL_ATTACKS.ridicule, actor, 3), 12);
  assert.equal(socialDamage(SOCIAL_DEFENSES.ignore, actor, 3), 5);
  assert.equal(socialDamage(SOCIAL_DEFENSES.subject, actor, 3), 11);
  assert.equal(socialDamage(SOCIAL_ATTACKS.persuade, actor, 3, 'exact'), 3.5);
  assert.equal(socialDamage(SOCIAL_ATTACKS.persuade, actor, 3, 'floor'), 3);
  assert.equal(socialDamage(SOCIAL_ATTACKS.persuade, actor, 3, 'ceil'), 4);
  assert.equal(socialMove('counter', { defense: true, counterAttack: 'deceive' }).skill, 'deceit');
  assert.throws(() => socialMove('parry', { defense: true }), /printed verbal defense/);
});

test('all unresolved conventions must be selected and Resolve rounding never silently floors the intermediate average', () => {
  assert.throws(() => validateSocialConventions({}), /resolveRounding/);
  assert.deepEqual(validateSocialConventions(conventions), conventions);
  assert.equal(initialResolve(actor, 'final'), 42);
  assert.equal(initialResolve(actor, 'average'), 40);
  assert.deepEqual(verbalDefenseResult(20, 20, 'blockOnly'), { defended: true, returnEffect: false });
  assert.deepEqual(verbalDefenseResult(20, 20, 'fullEffect'), { defended: true, returnEffect: true });
});

test('Appeal bonuses combine with Seduce only in the recorded scope and never add to antagonistic attacks', () => {
  const state = encounter();
  cumulativeDamage(state, 'A', 'B', { ...SOCIAL_ATTACKS.appeal, key: 'appeal' }, { increment: true });
  cumulativeDamage(state, 'A', 'B', { ...SOCIAL_ATTACKS.seduce, key: 'seduce' }, { increment: true });
  assert.equal(cumulativeDamage(state, 'A', 'B', { ...SOCIAL_ATTACKS.seduce, key: 'seduce' }), 3);
  assert.equal(cumulativeDamage(state, 'A', 'B', { ...SOCIAL_ATTACKS.deceive, key: 'deceive' }), 0);
  assert.equal(cumulativeDamage(state, 'C', 'B', { ...SOCIAL_ATTACKS.seduce, key: 'seduce' }), 0);
});

test('Romance, bitter defense and torture remain opponent- and attack-specific', () => {
  const state = encounter(),
    a = structuredClone(actor);
  a.system.social.relationships = [{ otherUuid: 'B', romance: 'active' }];
  assert.equal(socialModifiers(state, a, target, SOCIAL_ATTACKS.deceive).total, -3);
  a.system.social.relationships[0].romance = 'bitter';
  assert.equal(
    socialModifiers(
      state,
      a,
      target,
      { ...SOCIAL_DEFENSES.ignore, incomingFamily: 'empathetic' },
      { defense: true }
    ).total,
    3
  );
  assert.equal(
    socialModifiers(
      state,
      a,
      target,
      { ...SOCIAL_DEFENSES.ignore, incomingFamily: 'antagonistic' },
      { defense: true }
    ).total,
    0
  );
  state.torture = [{ actorUuid: 'A', targetUuid: 'B', severe: true }];
  assert.equal(socialModifiers(state, actor, target, SOCIAL_ATTACKS.intimidate).total, 10);
  assert.equal(socialModifiers(state, actor, target, SOCIAL_ATTACKS.deceive).total, 0);
  assert.equal(socialModifiers(state, actor, target, SOCIAL_ATTACKS.befriend).total, -10);
});
