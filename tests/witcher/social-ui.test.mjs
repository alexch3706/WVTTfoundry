import test from 'node:test';
import assert from 'node:assert/strict';
import { workflow } from './workflow-fixture.mjs';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { SOCIAL_CONVENTIONS } from '../../module/witcher/social-rules.js';
const conventions = Object.fromEntries(
  Object.entries(SOCIAL_CONVENTIONS).map(([key, choices]) => [key, choices[0]])
);
async function setup(t) {
  const w = await workflow(t);
  game.actors = new w.Collection([
    [w.attacker.id, w.attacker],
    [w.target.id, w.target],
  ]);
  game.messages = w.messages;
  game.user.targets = new Set();
  await w.target.update({ 'system.race': 'elf' });
  const runtime = await import('../../module/witcher/social-runtime.js');
  runtime.registerSocialCommands();
  const ui = await import('../../module/witcher/social-ui.js');
  return { ...w, runtime, ui };
}

test('actual social start wizard records goals and compact editable defaults in two dialogs', async (t) => {
  const w = await setup(t),
    screens = [];
  const message = await w.ui.startSocialCombat(w.attacker, {
    prompt: async (_title, html) => {
      screens.push(html);
      if (screens.length === 1) return { [`actor_${w.attacker.id}`]: true, [`actor_${w.target.id}`]: true };
      return {
        name: 'Gate argument',
        ...conventions,
        [`side_${w.attacker.id}`]: 'A',
        [`side_${w.target.id}`]: 'B',
        [`goal_${w.attacker.id}`]: 'Open the gate',
        [`goal_${w.target.id}`]: 'Keep it shut',
        [`order_${w.attacker.id}`]: 1,
        [`order_${w.target.id}`]: 2,
        [`rep_skill_${w.attacker.id}_persuasion`]: true,
      };
    },
  });
  assert.equal(screens.length, 2);
  assert.match(screens[1], /<details><summary>Table rulings/);
  assert.doesNotMatch(screens[1], /skill keys|UUID/);
  assert.equal(message.flags[SYSTEM_ID].participants[0].goal, 'Open the gate');
  assert.deepEqual(message.flags[SYSTEM_ID].participants[0].reputationSkills, ['persuasion']);
  assert.deepEqual(message.flags[SYSTEM_ID].conventions, conventions);
});

test('choosing a tool with no printed opposition asks the GM at that moment and then makes the actual roll', async (t) => {
  const w = await setup(t),
    { runCommand } = await import('../../module/witcher/authority.js');
  const message = await runCommand('socialStart', {
    conventions,
    conventionsConfirmed: true,
    participants: [
      { actorUuid: w.attacker.uuid, side: 'A', goal: 'Friendship' },
      { actorUuid: w.target.uuid, side: 'B', goal: 'Leave me alone' },
    ],
  });
  const screens = [];
  await w.ui.declareSocialAction(message, {
    prompt: async (_title, html) => {
      screens.push(html);
      if (screens.length === 1)
        return { move: 'romance', target_0: true, manualDice: '9', modifier: 0, luck: 0 };
      return { kind: 'dc', dc: '14', reason: 'Recorded table adjudication for this willing target.' };
    },
  });
  assert.equal(screens.length, 2);
  assert.match(screens[1], /Only Study supplies a printed DC/);
  assert.equal(message.flags[SYSTEM_ID].toolOpposition.romance.dc, 14);
  assert.equal(w.target.system.social.relationships[0].romance, 'active');
});

test('cancelled social dialogs never create an encounter or consume an action', async (t) => {
  const w = await setup(t),
    before = w.messages.size;
  assert.equal(await w.ui.startSocialCombat(w.attacker, { prompt: async () => null }), null);
  assert.equal(w.messages.size, before);
  assert.equal(w.attacker.system.combat.actions, 0);
});
