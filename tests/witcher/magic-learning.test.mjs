import test from 'node:test';
import assert from 'node:assert/strict';
import { magicInfo } from '../../module/witcher/magic-catalog.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { runCommand } from '../../module/witcher/authority.js';
import { workflow, clone } from './workflow-fixture.mjs';
import {
  learningRequirements,
  learningEligibility,
  beginLearningPlan,
  learningCheckPlan,
  finishLearningPlan,
  magicSkillImprovementPlan,
  placeOfPowerPlan,
  placeOfPowerBenefits,
  leyLineBenefits,
  leyDamageFormula,
  leyLineMishapPlan,
  registerMagicLearning,
  validateLeyContact,
  magicLearningDisplay,
} from '../../module/witcher/magic-learning.js';
const DAY = 86400;
const state = () => ({
  ip: 50,
  vigor: 2,
  effects: [],
  conditions: [],
  magic: { tradition: 'mage', birthEligible: true, magicIP: 0, learning: [] },
});
const begin = (s = state(), extra = {}) =>
  beginLearningPlan(s, magicInfo('aenye'), {
    id: 'learn1',
    time: 100,
    source: { description: 'Aenye formula in the academy library' },
    ...extra,
  });

test('Core learning table uses exact IP, time, DC and checks with the appropriate casting skill', () => {
  assert.deepEqual(learningRequirements('aenye'), {
    ip: 10,
    seconds: 4 * DAY,
    dc: 14,
    checks: 2,
    tier: 'novice',
    rulingRequired: false,
    skill: 'spellCasting',
  });
  assert.equal(learningRequirements({ tier: 'journeyman', kind: 'ritual' }).skill, 'ritualCrafting');
  assert.equal(learningRequirements({ tier: 'high', kind: 'hex' }).ip, 30);
  assert.deepEqual(learningRequirements({ tier: 'archpriest', kind: 'invocation' }), {
    ip: 40,
    seconds: 35 * DAY,
    dc: 24,
    checks: 8,
    tier: 'archpriest',
    rulingRequired: false,
    skill: 'spellCasting',
  });
  assert.throws(() => learningRequirements('quen'), /GM must record/);
  assert.equal(learningRequirements('quen', { tierRuling: 'novice' }).rulingRequired, true);
  assert.throws(() => learningRequirements({ tier: 'unspecified', kind: 'ritual' }), /GM/);
});

test('learning checks birth eligibility and tradition without treating temporary current Vigor as ancestry', () => {
  const actor = state();
  actor.vigor = 0;
  assert.equal(learningEligibility(actor, magicInfo('aenye')).allowed, true);
  actor.magic.birthEligible = null;
  assert.equal(learningEligibility(actor, magicInfo('aenye')).allowed, false);
  actor.magic.birthEligible = true;
  for (const tradition of ['witcher', 'priest', 'druid', 'talent']) {
    actor.magic.tradition = tradition;
    assert.equal(learningEligibility(actor, magicInfo('aenye')).allowed, false, tradition);
  }
  actor.magic.tradition = 'priest';
  assert.equal(learningEligibility(actor, magicInfo('blood-of-the-mountain')).allowed, true);
  actor.magic.tradition = 'witcher';
  assert.equal(learningEligibility(actor, magicInfo('quen')).allowed, true);
});

test('study consumes restricted magic IP first and requires a recorded teacher or tome', () => {
  const actor = state();
  actor.magic.magicIP = 7;
  const original = clone(actor),
    plan = begin(actor);
  assert.equal(plan.changes['system.ip'], 47);
  assert.equal(plan.changes['system.magic.magicIP'], 0);
  assert.deepEqual(plan.record.paid, { ordinary: 3, restricted: 7 });
  assert.deepEqual(actor, original);
  assert.throws(() => begin(actor, { source: { description: '' } }), /teacher or tome/);
  actor.ip = 2;
  assert.throws(() => begin(actor), /requires10 IP|requires 10 IP/);
});

test('a failed check ties its DC, adds one day, and cannot retry before the next day', () => {
  const project = begin().record;
  const failed = learningCheckPlan(project, { total: 14, time: 100 });
  assert.equal(failed.success, false);
  assert.equal(failed.record.readyAt, project.readyAt + DAY);
  assert.equal(failed.record.nextCheckAt, DAY);
  assert.throws(() => learningCheckPlan(failed.record, { total: 20, time: DAY - 1 }), /next day/);
  const retry = learningCheckPlan(failed.record, { total: 15, time: DAY });
  assert.equal(retry.record.successes, 1);
  assert.equal(project.failures, 0);
});

test('successful checks impose no invented daily interval but cannot skip total study time', () => {
  let project = begin().record;
  project = learningCheckPlan(project, { total: 20, time: 100 }).record;
  project = learningCheckPlan(project, { total: 20, time: 100 }).record;
  assert.equal(project.successes, 2);
  assert.throws(() => learningCheckPlan(project, { total: 20, time: 100 }), /checks are complete/);
  assert.throws(() => finishLearningPlan(project, 100), /more seconds/);
  assert.equal(finishLearningPlan(project, 100 + 4 * DAY).status, 'complete');
});

test('restricted magic IP can improve casting skills with the real doubled cost and rank cap', () => {
  const actor = state();
  actor.skills = { spellCasting: 4 };
  actor.magic.magicIP = 6;
  const plan = magicSkillImprovementPlan(actor, 'spellCasting');
  assert.equal(plan.cost, 8);
  assert.equal(plan.changes['system.skills.spellCasting'], 5);
  assert.equal(plan.changes['system.magic.magicIP'], 0);
  assert.equal(plan.changes['system.ip'], 48);
  assert.throws(() => magicSkillImprovementPlan(actor, 'athletics'), /three casting skills/);
  actor.skills.spellCasting = 10;
  assert.throws(() => magicSkillImprovementPlan(actor, 'spellCasting'), /0–9/);
});

test('Forgetfulness prevents learning and suppression of the hex restores eligibility', () => {
  const actor = state();
  actor.effects = [{ id: 'forget', magic: { kind: 'hex', key: 'hex-of-forgetfulness' } }];
  assert.equal(learningEligibility(actor, magicInfo('aenye')).allowed, false);
  actor.effects[0].magic.suppressed = true;
  assert.equal(learningEligibility(actor, magicInfo('aenye')).allowed, true);
});

test('repeated Place draws start at DC20 and increase only after successful Endurance checks', () => {
  const options = {
    sourceUuid: 'Region.place',
    element: 'fire',
    mode: 'attune',
    time: 0,
    monthSeconds: 28 * DAY,
  };
  const first = placeOfPowerPlan(null, options);
  assert.equal(first.dc, null);
  assert.equal(first.magicIP, 10);
  assert.equal(first.record.successes, 0);
  assert.deepEqual(placeOfPowerPlan(first.record, { ...options, time: 10 }), {
    needsEndurance: true,
    dc: 20,
  });
  const fail = placeOfPowerPlan(first.record, { ...options, time: 10, enduranceTotal: 20, damageRoll: 17 });
  assert.equal(fail.damage, 17);
  assert.equal(fail.backlash.condition, 'fire');
  assert.equal(fail.magicIP, 10);
  assert.equal(placeOfPowerPlan(fail.record, { ...options, time: 20 }).dc, 20);
  const success = placeOfPowerPlan(fail.record, { ...options, time: 20, enduranceTotal: 21 });
  assert.equal(placeOfPowerPlan(success.record, { ...options, time: 30 }).dc, 24);
  assert.equal(placeOfPowerPlan(success.record, { ...options, time: success.record.safeAgainAt }).dc, null);
  assert.throws(
    () => placeOfPowerPlan(first.record, { ...options, enduranceTotal: 2, damageRoll: 4 }),
    /5d6/
  );
});

test('Fifth Essence is an alternative benefit and a real month length is mandatory', () => {
  const options = {
    sourceUuid: 'Region.place',
    element: 'water',
    mode: 'essence',
    time: 1,
    monthSeconds: 31 * DAY,
  };
  const plan = placeOfPowerPlan(null, options);
  assert.equal(plan.essence, 5);
  assert.equal(plan.magicIP, 0);
  assert.equal(plan.benefit, null);
  assert.throws(() => placeOfPowerPlan(null, { ...options, monthSeconds: undefined }), /calendar month/);
  assert.equal(plan.record.safeAgainAt, 1 + 31 * DAY);
});

test('Place benefits remain element-qualified, last one hour and do not stack repeated draws', () => {
  const actor = state();
  actor.effects = [1, 2].map((id) => ({
    id,
    expires: 3600,
    magic: { placeOfPower: { element: 'fire', sourceUuid: 'Region.place' } },
  }));
  assert.equal(placeOfPowerBenefits(actor, magicInfo('aenye'), 100).vigor, 5);
  assert.equal(placeOfPowerBenefits(actor, magicInfo('aenye'), 100).castingBonus, 2);
  assert.equal(placeOfPowerBenefits(actor, magicInfo('quen'), 100).vigor, 0);
  assert.equal(placeOfPowerBenefits(actor, magicInfo('aenye'), 3600).vigor, 0);
});

test('Ley benefits enforce element restriction and exact earth, fire and water bonuses', () => {
  const actor = state();
  actor.magic.leyConnection = { active: true, element: 'earth' };
  assert.equal(leyLineBenefits(actor, magicInfo('aenye')).blocked, true);
  assert.equal(leyLineBenefits(actor, { kind: 'spell', element: 'earth' }).defenseModifier, -4);
  actor.magic.leyConnection.element = 'fire';
  assert.equal(leyLineBenefits(actor, magicInfo('aenye')).extraDamageDice, 2);
  assert.equal(leyLineBenefits(actor, magicInfo('aenye')).ignitionChance, 100);
  actor.magic.leyConnection.element = 'water';
  assert.equal(leyLineBenefits(actor, { kind: 'spell', element: 'water' }).castingBonus, 2);
  assert.equal(leyDamageFormula('4d8+3'), '6d8+3');
  assert.throws(() => leyDamageFormula('2'), /GM decision/);
});

test('air borrows only same-tier air spells without teaching or owning them', () => {
  const actor = state();
  actor.magic.leyConnection = { active: true, element: 'air' };
  const benefits = leyLineBenefits(
    actor,
    { kind: 'spell', element: 'air' },
    { knownMagic: ['adenydd', 'aenye'] }
  );
  assert.ok(benefits.borrowedMagic.includes('bronwyns-gust'));
  assert.ok(!benefits.borrowedMagic.includes('aenye'));
  assert.ok(!benefits.borrowedMagic.includes('gwynt-troelli'));
  actor.magic.leyConnection.active = false;
  assert.deepEqual(leyLineBenefits(actor, { element: 'air' }, { knownMagic: ['adenydd'] }).borrowedMagic, []);
});

test('priest and druid Ley connection grants +4 Vigor and cumulative six-hour penalties', () => {
  for (const tradition of ['priest', 'druid']) {
    const actor = state();
    actor.magic.tradition = tradition;
    actor.magic.leyConnection = { active: true, element: 'fire', sourceUuid: 'Region.ley' };
    assert.equal(leyLineBenefits(actor, magicInfo('blood-of-the-mountain')).vigor, 4);
    assert.equal(leyLineBenefits(actor, magicInfo('blood-of-the-mountain')).extraDamageDice, 0);
    const first = leyLineMishapPlan(actor, { time: 100, id: 'mishap1' });
    actor.effects = first.changes['system.effects'];
    const second = leyLineMishapPlan(actor, { time: 200, id: 'mishap2' });
    assert.equal(
      second.changes['system.effects'].reduce((sum, effect) => sum + effect.modifiers.vigor, 0),
      -4
    );
    assert.equal(second.changes['system.effects'][0].expires, 100 + 21600);
    assert.equal(second.changes['system.effects'][1].expires, 200 + 21600);
  }
});

test('Ley extra mishaps are explicit transactions or jobs rather than inert automatic rule cards', () => {
  const actor = state(),
    cast = { castId: 'cast1', magic: magicInfo('aenye'), staCost: 4 };
  actor.magic.leyConnection = { active: true, element: 'earth', sourceUuid: 'Region.ley', dc: 18 };
  assert.equal(leyLineMishapPlan(actor).changes['system.magic.leyConnection'].dc, 20);
  assert.equal(leyLineMishapPlan(actor).changes['system.magic.leyConnection'].active, false);
  actor.magic.leyConnection.element = 'air';
  assert.equal(leyLineMishapPlan(actor, { cast }).jobs[0].mustResolveDespiteFumble, true);
  assert.equal(leyLineMishapPlan(actor, { cast }).jobs[0].originalSTA, 4);
  actor.magic.leyConnection.element = 'fire';
  assert.equal(leyLineMishapPlan(actor, { cast }).jobs[0].ordinaryFumbleOnly, true);
  actor.magic.leyConnection.element = 'water';
  assert.deepEqual(leyLineMishapPlan(actor, { id: 'hallucination1' }).changes['system.conditions'], [
    'hallucinating',
  ]);
});

async function runtimeFixture(t) {
  const w = await workflow(t);
  game.combat = null;
  await w.attacker.update({
    'system.ip': 50,
    'system.vigor': 2,
    'system.magic': {
      tradition: 'mage',
      birthEligible: true,
      magicIP: 0,
      learning: [],
      powerUses: [],
      powerFocus: {},
      leyConnection: {},
    },
  });
  const scene = { uuid: 'Scene.learning' },
    token = {
      uuid: 'Scene.learning.Token.caster',
      documentName: 'Token',
      actor: w.attacker,
      parent: scene,
      touching: true,
      testInsideRegion() {
        return this.touching;
      },
    };
  const source = {
    uuid: 'Scene.learning.Region.power',
    documentName: 'Region',
    parent: scene,
    name: 'Ancient standing stone',
    flags: { [SYSTEM_ID]: { magicSource: { kind: 'place', element: 'earth', monthSeconds: 30 * DAY } } },
    async update(changes) {
      for (const [key, value] of Object.entries(changes)) foundry.utils.setProperty(this, key, value);
      return this;
    },
  };
  w.docs.set(token.uuid, token);
  w.docs.set(source.uuid, source);
  registerMagicLearning();
  const start = () =>
    runCommand('magicLearnStart', {
      actorUuid: w.attacker.uuid,
      magicKey: 'aenye',
      source: { description: 'Teacher in Ban Ard' },
    });
  const power = () =>
    runCommand('magicPowerConcentrate', {
      actorUuid: w.attacker.uuid,
      sourceUuid: source.uuid,
      tokenUuid: token.uuid,
      mode: 'attune',
      turn: '',
    });
  return { ...w, token, source, start, power };
}

test('a failed learning-start chat receipt rolls back both pools and the new project', async (t) => {
  const w = await runtimeFixture(t),
    before = clone(w.attacker._source);
  w.faults.create = () => true;
  await assert.rejects(w.start(), /Injected/);
  assert.deepEqual(w.attacker._source, before);
  w.faults.create = null;
  await w.start();
  assert.equal(w.attacker.system.ip, 40);
  assert.equal(w.attacker.system.magic.learning.length, 1);
});

test('real learning check uses manual d10 and rolls back Luck/progress if persistence fails', async (t) => {
  const w = await runtimeFixture(t);
  await w.start();
  const projectId = w.attacker.system.magic.learning[0].id,
    before = clone(w.attacker._source);
  w.faults.create = () => true;
  await assert.rejects(
    runCommand('magicLearnCheck', {
      actorUuid: w.attacker.uuid,
      projectId,
      values: { manualDice: '6', luck: 1 },
    }),
    /Injected/
  );
  assert.deepEqual(w.attacker._source, before);
  w.faults.create = null;
  await runCommand('magicLearnCheck', { actorUuid: w.attacker.uuid, projectId, values: { manualDice: '6' } });
  assert.equal(w.attacker.system.magic.learning[0].successes, 1);
});

test('learning completion creates the real catalog item once and compensates it on chat failure', async (t) => {
  const w = await runtimeFixture(t);
  await w.start();
  const record = w.attacker.system.magic.learning[0];
  record.successes = 2;
  game.time.worldTime = record.readyAt;
  const payload = { actorUuid: w.attacker.uuid, projectId: record.id };
  w.faults.create = () => true;
  await assert.rejects(runCommand('magicLearnFinish', payload), /Injected/);
  assert.equal(
    w.attacker.items.some((item) => item.type === 'magic'),
    false
  );
  assert.equal(w.attacker.system.magic.learning[0].status, 'studying');
  w.faults.create = null;
  await runCommand('magicLearnFinish', payload);
  assert.equal(
    w.attacker.items.filter((item) => item.type === 'magic' && item.system.magic.key === 'aenye').length,
    1
  );
  await assert.rejects(runCommand('magicLearnFinish', payload), /no longer active/);
});

test('Place concentration enforces nine world-time seconds and source contact before the real benefit', async (t) => {
  const w = await runtimeFixture(t);
  await w.power();
  const readyAt = w.attacker.system.magic.powerFocus.readyAt;
  assert.equal(w.attacker.system.magic.magicIP, 0);
  await assert.rejects(w.power(), /more seconds/);
  game.time.worldTime = readyAt;
  w.token.touching = false;
  await assert.rejects(w.power(), /physically inside/);
  w.token.touching = true;
  await w.power();
  assert.equal(w.attacker.system.magic.magicIP, 10);
  assert.equal(w.attacker.system.magic.powerUses.length, 1);
  assert.equal(placeOfPowerBenefits(w.attacker.system, magicInfo('quen'), game.time.worldTime).vigor, 5);
});

test('Ley connection enforces source contact, native restriction and an actual Spell Casting result', async (t) => {
  const w = await runtimeFixture(t);
  w.source.flags[SYSTEM_ID].magicSource = { kind: 'ley', element: 'water' };
  const payload = {
    actorUuid: w.attacker.uuid,
    sourceUuid: w.source.uuid,
    tokenUuid: w.token.uuid,
    turn: '',
    values: { manualDice: '8' },
  };
  w.token.touching = false;
  await assert.rejects(runCommand('magicLeyConnect', payload), /physically inside/);
  w.token.touching = true;
  await runCommand('magicLeyConnect', payload);
  assert.equal(w.attacker.system.magic.leyConnection.active, true);
  assert.equal(await validateLeyContact(w.attacker), true);
  w.token.touching = false;
  assert.equal(await validateLeyContact(w.attacker), false);
  await runCommand('magicLeyDisconnect', { actorUuid: w.attacker.uuid });
  assert.equal(w.attacker.system.magic.leyConnection.active, false);
  w.attacker.system.magic.tradition = 'witcher';
  await assert.rejects(runCommand('magicLeyConnect', payload), /Only mages/);
});

test('failed Ley connection causes the elemental condition but no additional HP damage', async (t) => {
  const w = await runtimeFixture(t);
  w.source.flags[SYSTEM_ID].magicSource = { kind: 'ley', element: 'fire' };
  const hp = w.attacker.system.hp.value;
  await runCommand('magicLeyConnect', {
    actorUuid: w.attacker.uuid,
    sourceUuid: w.source.uuid,
    tokenUuid: w.token.uuid,
    turn: '',
    values: { manualDice: '2' },
  });
  assert.equal(w.attacker.system.magic.leyConnection.active, false);
  assert.equal(w.attacker.system.hp.value, hp);
  assert.ok(w.attacker.system.conditions.includes('fire'));
});

test('learning display exposes only eligible study/finish controls from persisted progress', async (t) => {
  const w = await runtimeFixture(t);
  await w.start();
  let display = magicLearningDisplay(w.attacker, game.time.worldTime);
  assert.equal(display.projects[0].canCheck, true);
  assert.equal(display.projects[0].canFinish, false);
  const record = w.attacker.system.magic.learning[0];
  record.successes = record.requirements.checks;
  display = magicLearningDisplay(w.attacker, record.readyAt);
  assert.equal(display.projects[0].canCheck, false);
  assert.equal(display.projects[0].canFinish, true);
});

test('a recorded spell formula gives the printed +2 learning bonus', async (t) => {
  const w = await runtimeFixture(t);
  await runCommand('magicLearnStart', {
    actorUuid: w.attacker.uuid,
    magicKey: 'aenye',
    source: { description: 'Aenye spell formula', formula: true },
  });
  const record = w.attacker.system.magic.learning[0];
  await runCommand('magicLearnCheck', {
    actorUuid: w.attacker.uuid,
    projectId: record.id,
    values: { manualDice: '3' },
  });
  assert.equal(w.attacker.system.magic.learning[0].attempts[0].total, 15);
  assert.equal(w.attacker.system.magic.learning[0].successes, 1);
});

test('in combat a Place requires three distinct full turns and rolls back the final benefit on chat failure', async (t) => {
  const w = await runtimeFixture(t);
  game.combat = { id: 'studyCombat', started: true, round: 1, turn: 0, combatant: { actor: w.attacker } };
  const draw = () =>
    runCommand('magicPowerConcentrate', {
      actorUuid: w.attacker.uuid,
      sourceUuid: w.source.uuid,
      tokenUuid: w.token.uuid,
      mode: 'attune',
      turn: `studyCombat:${game.combat.round}:0`,
    });
  await draw();
  assert.equal(w.attacker.system.combat.full, true);
  await assert.rejects(draw(), /full-round|already been recorded/);
  game.combat.round = 2;
  await draw();
  assert.equal(w.attacker.system.magic.powerFocus.turns, 2);
  const before = clone(w.attacker._source);
  game.combat.round = 3;
  w.faults.create = () => true;
  await assert.rejects(draw(), /Injected/);
  assert.deepEqual(w.attacker._source, before);
  w.faults.create = null;
  await draw();
  assert.equal(w.attacker.system.magic.magicIP, 10);
  assert.equal(w.attacker.system.magic.powerFocus.turns, undefined);
});

test('an air Ley connection failure creates a real pending-backlash card without additional HP loss', async (t) => {
  const w = await runtimeFixture(t);
  w.source.flags[SYSTEM_ID].magicSource = { kind: 'ley', element: 'air' };
  const hp = w.attacker.system.hp.value;
  const card = await runCommand('magicLeyConnect', {
    actorUuid: w.attacker.uuid,
    sourceUuid: w.source.uuid,
    tokenUuid: w.token.uuid,
    turn: '',
    values: { manualDice: '2' },
  });
  assert.equal(w.attacker.system.hp.value, hp);
  assert.equal(card.flags[SYSTEM_ID].kind, 'magic-backlash');
  assert.equal(card.flags[SYSTEM_ID].backlash.pushMeters, 2);
  assert.equal(card.flags[SYSTEM_ID].backlashResolved, false);
  assert.ok(card.content.includes('data-magic-action="backlash"'));
});

test('priests use the mixed random elemental result when opening a Ley Line fails', async (t) => {
  const w = await runtimeFixture(t);
  w.attacker.system.magic.tradition = 'priest';
  w.source.flags[SYSTEM_ID].magicSource = { kind: 'ley', element: 'fire' };
  w.enqueue(['1d4', 4]);
  await runCommand('magicLeyConnect', {
    actorUuid: w.attacker.uuid,
    sourceUuid: w.source.uuid,
    tokenUuid: w.token.uuid,
    turn: '',
    values: { manualDice: '2' },
  });
  assert.ok(w.attacker.system.conditions.includes('frozen'));
  assert.ok(!w.attacker.system.conditions.includes('fire'));
});
