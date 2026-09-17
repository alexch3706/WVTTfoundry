import { test } from 'node:test';
import assert from 'node:assert/strict';
import { magicInfo, MAGIC } from '../../module/witcher/magic-catalog.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import {
  RITUAL_KEYS,
  spellJarRow,
  compressedDeathChanges,
  prepareRitualSpecialMishap,
  ritualNecromancyBonuses,
  ritualActionRestriction,
  ritualEffectPlan,
  ritualSupport,
  restlessSpiritsPlan,
  ritualMishapPlan,
  createRitualProcedureHandlers,
  ritualTargetingBlock,
  registerRitualRegions,
  RITUAL_REGION_BEHAVIOR,
} from '../../module/witcher/magic-ritual-effects.js';

const choices = {
  mode: 'past',
  effectIds: [],
  question: 'What happened here?',
  message: 'The gate opens at dawn.',
  messageSeconds: 120,
  triggers: ['Touch the stone'],
  burialSiteConfirmed: true,
  deceasedUuid: 'Actor.dead',
  recipientUuid: 'Actor.recipient',
  radius: 7,
  material: 'silver',
  participants: ['Actor.friend'],
  trophyItemId: 'trophy',
  species: 'griffin',
  helpedKillActorUuids: ['Actor.mage'],
  animal: 'cat',
  armorItemIds: ['helmet', 'chest', 'legs'],
  location: 'Old tower',
  regionUuid: 'Scene.s.Region.r',
  element: 'earth',
  leyLinesConfirmed: true,
  storedMagicItemIds: ['spell'],
  corpseUuids: Array.from({ length: 10 }, (_, index) => `Actor.dead${index}`),
  skullType: 'humanElderfolk',
  corpseUuid: 'Actor.dead',
  organsConfirmed: true,
  demonProfileUuid: 'Actor.demon',
  offeringConfirmed: true,
  demonUuid: 'Actor.demon',
  trueName: 'Example',
  fortnightConfirmed: true,
};
function ready(key, options = {}) {
  return ritualEffectPlan(key, {
    ritualRank: 7,
    castTotal: 25,
    choices: {
      ...choices,
      ...(key === 'cleansing-ritual' ? { mode: 'poison' } : {}),
      ...(key === 'ritual-of-magic' ? { mode: 'vigor' } : {}),
      ...options.choices,
    },
    rolls: { essence: 5, days: 4, duration: 6, ...options.rolls },
    ...Object.fromEntries(Object.entries(options).filter(([key]) => !['choices', 'rolls'].includes(key))),
  });
}

test('all34 catalog rituals have source-backed plans and no unknown or missing registry keys', () => {
  assert.equal(RITUAL_KEYS.length, 34);
  assert.deepEqual(
    new Set(RITUAL_KEYS),
    new Set(MAGIC.filter((entry) => entry.kind === 'ritual').map((entry) => entry.key))
  );
  for (const key of RITUAL_KEYS) {
    const plan = ready(key);
    assert.equal(plan.ready, true, key);
    assert.ok(plan.operations.length, key);
    assert.equal(plan.source, magicInfo(key).source);
    assert.equal(plan.page, magicInfo(key).page);
  }
});
test('missing real choices expose requirements and never emit executable outcome placeholders', () => {
  const plan = ritualEffectPlan('cleansing-ritual');
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(
    plan.requirements.map((entry) => entry.key),
    ['mode', 'effectIds']
  );
  assert.throws(() => ready('consecrate', { choices: { radius: 11 } }), /10 metres/);
  assert.throws(() => ready('magical-message', { choices: { messageSeconds: 301 } }), /five minutes/);
  assert.throws(() => ready('oneiromancy', { choices: { participants: ['a', 'a'] } }), /distinct/);
  assert.throws(
    () => ready('cadfans-synthesis', { choices: { corpseUuids: Array(10).fill('same') } }),
    /ten different/
  );
});
test('Life and Magic circle plans preserve exact ticks, exit behavior, rounding and first-use restrictions', () => {
  const life = ready('ritual-of-life').operations[0];
  assert.equal(life.healing, 3);
  assert.equal(life.totalTicks, 10);
  assert.equal(life.endsOnExit, true);
  assert.equal(life.radius, null);
  const vigor = ready('ritual-of-magic').operations[0];
  assert.equal(vigor.bonus, 3);
  assert.equal(vigor.duration.seconds, 18000);
  assert.equal(vigor.firstMagicalOccupant, true);
  const material = ready('ritual-of-magic', { choices: { mode: 'essence' }, rolls: { essence: 1 } })
    .operations[0];
  assert.equal(material.quantity, 0.5);
});
test('Consecrate, barrier and illusion plans include printed crossing, geometry and immunity distinctions', () => {
  const consecrate = ready('consecrate').operations[0];
  assert.deepEqual(consecrate.crossing, { skill: 'resistMagic', dc: 25, entering: true, leaving: true });
  assert.equal(consecrate.blocksMonsterMagic, true);
  assert.equal(consecrate.passesOrdinaryProjectiles, true);
  const barrier = ready('magic-barrier').operations[1];
  assert.equal(barrier.radius, 5);
  assert.equal(barrier.hp, 50);
  assert.equal(barrier.hpPerExtraSTA, 5);
  assert.equal(barrier.teleportPasses, true);
  assert.equal(barrier.airWhenStoppedRounds, 20);
  const illusion = ready('interactive-illusion').operations[0];
  assert.equal(illusion.radius, 20);
  assert.deepEqual(illusion.hazardSave, {
    skills: ['resistMagic', 'endurance'],
    dc: 12,
    failure: 'stunSave',
  });
  assert.equal(illusion.lethalDamage, false);
});
test('Artifact Compression retains its distinct body damage, one-fifth HP and release consequences', () => {
  const op = ready('artifact-compression').operations[0];
  assert.equal(op.scale, 0.1);
  assert.equal(op.hpDivisor, 5);
  assert.equal(op.hpRound, 'up');
  assert.equal(op.failedSaveDamage, '6d6');
  assert.equal(op.limbBreakDC, 14);
  assert.equal(op.limbDamage, 5);
  assert.equal(op.releaseStunned, true);
  assert.equal(op.zeroHPFatal, true);
});
test('Spell Jar preserves rolled expiry and makes the printed zero-row ambiguity explicit', () => {
  const op = ready('spell-jar').operations[0];
  assert.equal(op.duration.seconds, 4 * 86400);
  assert.equal(op.choices.length, 5);
  assert.equal(op.selectionFormula, '1d10/2');
  assert.match(op.roundingAmbiguity, /odd results/);
});
test('Tyromancy false answers follow its secret die parity, including failed casting', () => {
  assert.equal(
    ready('tyromancy', { success: false, choices: { dcRoll: 3 } }).operations[0].answerIfFailure,
    'negative'
  );
  assert.equal(
    ready('tyromancy', { success: false, choices: { dcRoll: 4 } }).operations[0].answerIfFailure,
    'positive'
  );
  assert.equal(
    ready('tyromancy', { success: true, choices: { dcRoll: 4 } }).operations[0].answerIfFailure,
    null
  );
  assert.deepEqual(ready('golem-crafting', { success: false }).operations, []);
  assert.equal(ready('ritual-of-naming', { success: false }).operations[0].rule.key, 'lucifuge-mark');
});
test('necromantic and goetic result plans retain their dangerous special mechanics', () => {
  const dream = ready('hanmarvyns-blue-dream', { choices: { hallucinogens: true } }).operations[0];
  assert.equal(dream.duration.seconds, 1200);
  assert.equal(dream.enduranceDC, 24);
  assert.equal(dream.visionDespiteFailure, true);
  const reanimate = ready('reanimate-corpse').operations;
  assert.equal(reanimate[0].maintenanceIntervalSeconds, 60);
  assert.equal(reanimate[1].resistCoercion, -3);
  assert.equal(reanimate[1].tortureTormentIneffective, true);
  const binding = ready('ritual-of-binding').operations[0];
  assert.equal(binding.cageDurationSeconds, 86400);
  assert.equal(binding.escapeCheckIntervalSeconds, 1209600);
  assert.equal(binding.escapeDC, 25);
  assert.equal(binding.secretEscapeCheck, true);
  assert.equal(ready('controlled-summoning').operations[0].controlled, false);
});
test('Restless Spirits is cumulative at every printed tier threshold and allows beacon-modified rolls below1', () => {
  assert.deepEqual(
    restlessSpiritsPlan('novice', 5).map((entry) => entry.type),
    ['gateway']
  );
  assert.deepEqual(
    restlessSpiritsPlan('novice', 6).map((entry) => entry.type),
    ['gateway', 'uninvitedGuest']
  );
  assert.deepEqual(
    restlessSpiritsPlan('journeyman', 8).map((entry) => entry.type),
    ['gateway', 'uninvitedGuest', 'wraiths']
  );
  assert.deepEqual(
    restlessSpiritsPlan('master', 10).map((entry) => entry.type),
    ['gateway', 'uninvitedGuest', 'wraiths', 'haunting', 'penitent']
  );
  assert.deepEqual(restlessSpiritsPlan('master', 0), []);
  assert.equal(ritualMishapPlan(magicInfo('reanimate-corpse'), { fumble: 7, restlessRoll: 8 }).damage, 7);
});
test('support reflects actual executor availability, independently of all34 metadata plans', () => {
  assert.equal(ritualSupport('golem-crafting').supported, true);
  assert.equal(ritualSupport('artifact-compression').supported, true);
  assert.deepEqual(ritualSupport('not-a-ritual').missing, ['ritual']);
  assert.equal(ritualSupport('consecrate', { adapters: { consecrate: { prepare() {} } } }).supported, true);
  assert.equal(
    ritualSupport('create-soul-beacon', { adapters: { soulBeacon: { prepare() {} } } }).supported,
    false
  );
  assert.equal(ritualSupport('enchant-amulet', { adapters: { amulet: { prepare() {} } } }).supported, false);
  assert.equal(ritualSupport('enchant-amulet', { dedicatedAmulet: true }).supported, true);
});

function fixture(t, key) {
  const globals = ['foundry', 'game', 'ChatMessage', 'Roll'];
  const saved = new Map(globals.map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of saved)
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  });
  let next = 0;
  const created = [];
  globalThis.foundry = { utils: { randomID: () => String(++next) } };
  globalThis.game = {
    user: { id: 'gm', isGM: true },
    users: [{ id: 'gm', isGM: true }],
    settings: { get: () => 'publicroll' },
    scenes: [],
    actors: [],
    combat: null,
    time: { worldTime: 30 },
  };
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    applyRollMode: () => {},
    async create(data) {
      if (created.fail) throw new Error('Cannot create');
      const doc = {
        ...data,
        uuid: `Chat.${++next}`,
        async delete() {
          created.splice(created.indexOf(doc), 1);
        },
      };
      created.push(doc);
      return doc;
    },
  };
  const state = { skills: { ritualCrafting: 7 }, conditions: [], effects: [], hp: { value: 20, max: 30 } };
  const actor = {
    uuid: 'Actor.mage',
    name: 'Mage',
    system: state,
    async createEmbeddedDocuments(type, documents) {
      if (created.fail) throw new Error('Cannot create');
      return documents.map((data) => {
        const doc = {
          ...data,
          uuid: `Actor.mage.Item.${++next}`,
          async delete() {
            created.splice(created.indexOf(doc), 1);
          },
        };
        created.push(doc);
        return doc;
      });
    },
  };
  const context = {
    actor,
    target: actor,
    magic: magicInfo(key),
    actorState: structuredClone(state),
    targetState: structuredClone(state),
    castId: 'cast',
    check: { total: 25, fumble: 0 },
    time: 30,
    cost: { staCost: 3 },
    choices: { ...choices, mode: 'poison' },
    success: true,
    user: game.user,
  };
  return { created, actor, context };
}
test('cleansing changes only selected matching affliction sources and keeps unrelated overlapping conditions', async (t) => {
  const f = fixture(t, 'cleansing-ritual');
  f.context.actorState.effects = [
    { id: 'p', key: 'Poison', conditions: ['poison'], magic: { addedConditions: ['poison'] } },
    { id: 'other', key: 'Other poison', conditions: ['poison'], magic: { addedConditions: [] } },
  ];
  f.context.actorState.conditions = ['poison'];
  f.context.targetState = f.context.actorState;
  f.context.choices.effectIds = ['p'];
  const result = await createRitualProcedureHandlers().planRitualResult(f.context);
  assert.deepEqual(
    result.plans[0].changes['system.effects'].map((e) => e.id),
    ['other']
  );
  assert.deepEqual(result.plans[0].changes['system.conditions'], ['poison']);
  assert.equal(f.actor.system.effects.length, 0);
  f.context.actorState.effects = [{ id: 'plague', key: 'Catriona', plague: true }];
  f.context.choices.effectIds = ['plague'];
  await assert.rejects(() => createRitualProcedureHandlers().planRitualResult(f.context), /plague/);
});
test('maintained scrying prepares real lifecycle state and an explicit pending GM reveal with rollback', async (t) => {
  const f = fixture(t, 'hydromancy');
  f.context.choices.mode = 'present';
  const result = await createRitualProcedureHandlers().planRitualResult(f.context);
  const effect = result.plans[0].changes['system.effects'][0];
  assert.equal(effect.magic.maintenance, 'fixed');
  assert.equal(effect.magic.nextUpkeepAt, 33);
  assert.equal(effect.magic.casterEffect, true);
  assert.equal(f.created.length, 0);
  const executed = await result.execute();
  assert.equal(executed.status, 'pendingGM');
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.created[0].whisper, ['gm']);
  assert.equal(f.created[0].flags[SYSTEM_ID].magicDecision.status, 'pendingGM');
  await executed.rollback();
  assert.equal(f.created.length, 0);
});
test('Magical Message creates a real owned Item only inside execute and compensates it on rollback', async (t) => {
  const f = fixture(t, 'magical-message');
  const result = await createRitualProcedureHandlers().planRitualResult(f.context);
  assert.equal(f.created.length, 0);
  const executed = await result.execute();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].type, 'gear');
  assert.equal(f.created[0].flags[SYSTEM_ID].ritualArtifact.message, 'The gate opens at dawn.');
  assert.equal(f.created[0].flags[SYSTEM_ID].ritualArtifact.castId, 'cast');
  await executed.rollback();
  assert.equal(f.created.length, 0);
});
test('compression rejects a missing actual scene before world writes', async (t) => {
  const f = fixture(t, 'artifact-compression');
  await assert.rejects(
    () => createRitualProcedureHandlers().planRitualResult(f.context),
    /actual ritual caster token/
  );
  assert.equal(f.created.length, 0);
});

test('ritual targeting blocks monster magic across Consecrate while ordinary projectiles pass', () => {
  const region = {
    uuid: 'Region.r',
    flags: {
      [SYSTEM_ID]: { ritualArea: { active: true, type: 'consecrate', operation: { material: 'silver' } } },
    },
  };
  const scene = { id: 's', regions: [region] };
  const source = {
    parent: scene,
    actor: { type: 'monster', system: { category: 'specter', silverVulnerable: true } },
    testInsideRegion: () => false,
  };
  const target = { parent: scene, testInsideRegion: () => true };
  assert.match(ritualTargetingBlock(source, target, { magic: true }).reason, /Consecrate/);
  assert.equal(ritualTargetingBlock(source, target, { magic: false, solidEffect: true }), null);
  source.actor.system.category = 'humanoid';
  assert.equal(ritualTargetingBlock(source, target, { magic: true }), null);
  source.actor.system.category = 'specter';
  region.flags[SYSTEM_ID].ritualArea.traditionalVulnerabilities = true;
  region.flags[SYSTEM_ID].ritualArea.operation.material = 'meteorite';
  assert.equal(ritualTargetingBlock(source, target, { magic: true }), null);
});

test('the solid barrier blocks solid crossing attacks while teleportation is explicitly exempt', () => {
  const region = {
      uuid: 'Region.r',
      flags: { [SYSTEM_ID]: { ritualArea: { active: true, type: 'barrier' } } },
    },
    scene = { id: 's', regions: [region] };
  const source = { parent: scene, testInsideRegion: () => false },
    target = { parent: scene, testInsideRegion: () => true };
  assert.match(ritualTargetingBlock(source, target, { solidEffect: true }).reason, /solid magic barrier/);
  assert.equal(ritualTargetingBlock(source, target, { solidEffect: true, teleport: true }), null);
  assert.equal(
    ritualTargetingBlock(source, target, { magic: true }),
    null,
    'spell material behavior must be explicitly supplied'
  );
});

test('native V14 ritual behavior pauses only the initiating client at a blocking boundary and exempts teleport/incorporeal travel', (t) => {
  const keys = ['foundry', 'game', 'Hooks', 'CONFIG'];
  const saved = new Map(keys.map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of saved)
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
  });
  const callbacks = new Map();
  globalThis.Hooks = { on: (key, fn) => callbacks.set(key, fn), once: () => {} };
  globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} } } };
  globalThis.CONFIG = {
    RegionBehavior: { dataModels: {} },
    Token: { movement: { actions: { walk: {}, teleport: { teleport: true } } } },
  };
  globalThis.game = { user: { id: 'player', isGM: false }, users: [] };
  const Behavior = registerRitualRegions();
  assert.equal(CONFIG.RegionBehavior.dataModels[RITUAL_REGION_BEHAVIOR], Behavior);
  const paused = [],
    token = {
      x: 0,
      y: 0,
      elevation: 0,
      actor: { system: { effects: [], traits: {} } },
      pauseMovement: (key) => paused.push(key),
    };
  const event = {
    name: 'tokenMoveIn',
    region: { uuid: 'Region.r', flags: { [SYSTEM_ID]: { ritualArea: { active: true, type: 'barrier' } } } },
    data: {
      token,
      movement: { id: 'move1', passed: { waypoints: [{ x: 1, y: 2, elevation: 0, action: 'walk' }] } },
    },
    user: { isSelf: true },
  };
  Behavior.events.tokenMoveIn(event);
  assert.equal(paused.length, 1);
  assert.match(paused[0], /Region.r:tokenMoveIn/);
  event.user.isSelf = false;
  Behavior.events.tokenMoveIn(event);
  assert.equal(paused.length, 1);
  event.user.isSelf = true;
  event.data.movement.passed.waypoints[0].action = 'teleport';
  Behavior.events.tokenMoveIn(event);
  assert.equal(paused.length, 1);
  event.data.movement.passed.waypoints[0].action = 'walk';
  token.actor.system.traits.alwaysIncorporeal = true;
  Behavior.events.tokenMoveIn(event);
  assert.equal(paused.length, 1);
});

function queueDice(values) {
  globalThis.Roll = class {
    static validate() {
      return true;
    }
    constructor(formula) {
      this.formula = formula;
    }
    async evaluate() {
      this.total = values.shift();
      assert.ok(Number.isFinite(this.total), 'an actual fixture die is required');
      return this;
    }
  };
}
function placedActor(actor, x = 0) {
  const scene = { id: 's', grid: { size: 100, distance: 2, units: 'm' }, tokens: [], regions: [] };
  const token = {
    uuid: `Scene.s.Token.${actor.uuid}`,
    actor,
    parent: scene,
    x,
    y: 0,
    elevation: 0,
    level: 'level',
    getMovementOrigin() {
      return { x: this.x, y: this.y, elevation: this.elevation };
    },
  };
  scene.tokens.push(token);
  game.scenes = [scene];
  return { scene, token };
}
test('Spell Jar requires a chosen odd-half convention and preserves every genuine die face', () => {
  assert.throws(() => spellJarRow(1, ''), /explicit table convention/);
  assert.deepEqual(
    Array.from({ length: 10 }, (_, i) => spellJarRow(i + 1, 'odd-up')),
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  );
  assert.equal(spellJarRow(1, 'odd-down-minimum-one'), 1);
  assert.throws(() => spellJarRow(0, 'odd-up'), /genuine d10/);
});
test('compressed HP zero is immediately fatal without ordinary stabilization or death saves', () => {
  const actor = {
    system: { conditions: ['unconscious'] },
    flags: { [SYSTEM_ID]: { artifactCompression: { active: true } } },
  };
  assert.deepEqual(compressedDeathChanges(actor, 1), {});
  assert.deepEqual(compressedDeathChanges(actor, 0), {
    'system.conditions': ['unconscious', 'dead'],
    'system.pendingDeathSaves': 0,
    'system.stabilized': false,
  });
  actor.flags[SYSTEM_ID].artifactCompression.active = false;
  assert.deepEqual(compressedDeathChanges(actor, -8), {});
});
test('necromantic fumble uses actual severity, preserves projected overdraw loss, and prepares a timed Gateway without world writes', async (t) => {
  const f = fixture(t, 'reanimate-corpse');
  queueDice([1]);
  f.context.check.fumble = 7;
  f.context.actorState.hp.value = 14;
  f.context.cost = { staCost: 10, elementalBacklash: true };
  const prepared = await prepareRitualSpecialMishap(f.context);
  assert.equal(prepared.plans[0].changes['system.hp.value'], 7);
  const gateway = prepared.plans[1].changes['system.effects'][0];
  assert.equal(gateway.magic.key, 'gateway-to-the-dead');
  assert.equal(gateway.expires, 86430);
  assert.equal(gateway.magic.necromancyBonus, 2);
  assert.deepEqual(gateway.magic.triggerFaces, [1, 2, 3]);
  assert.equal(f.created.length, 0);
  assert.equal(f.actor.system.hp.value, 20);
});
test('an unspecified ritual element creates an actionable pending GM backlash and compensates its chat document', async (t) => {
  const f = fixture(t, 'hydromancy');
  f.context.cost = { staCost: 3, elementalBacklash: true };
  const prepared = await prepareRitualSpecialMishap(f.context);
  assert.equal(f.created.length, 0);
  assert.deepEqual(prepared.plans, []);
  const result = await prepared.execute();
  assert.equal(result.status, 'pendingGM');
  assert.equal(f.created[0].flags[SYSTEM_ID].kind, 'ritual-mishap');
  assert.match(f.created[0].content, /data-ritual-mishap/);
  await result.rollback();
  assert.equal(f.created.length, 0);
});
test('Soul Beacons never combine overlapping human and beast bonuses; a real selected source determines one benefit', () => {
  const old = globalThis.game;
  globalThis.game = { time: { worldTime: 30 } };
  try {
    const actor = { uuid: 'Actor.necro', system: { effects: [] }, flags: {} },
      scene = { id: 's', grid: { size: 100, distance: 2, units: 'm' }, tokens: [] };
    const token = (a, x) => ({
      actor: a,
      parent: scene,
      level: 'l',
      getMovementOrigin: () => ({ x, y: 0, elevation: 0 }),
    });
    const caster = token(actor, 0),
      human = {
        uuid: 'Actor.human',
        system: { hp: { value: 10 } },
        flags: {
          [SYSTEM_ID]: {
            ritualStructure: { key: 'create-soul-beacon', skullType: 'humanElderfolk', expiresAt: 100 },
          },
        },
      },
      beast = {
        uuid: 'Actor.beast',
        system: { hp: { value: 10 } },
        flags: {
          [SYSTEM_ID]: {
            ritualStructure: { key: 'create-soul-beacon', skullType: 'beastMonster', expiresAt: 100 },
          },
        },
      };
    scene.tokens = [caster, token(human, 100), token(beast, 200)];
    assert.throws(() => ritualNecromancyBonuses(actor, caster), /Only one/);
    actor.flags[SYSTEM_ID] = { soulBeaconUuid: human.uuid };
    const benefits = ritualNecromancyBonuses(actor, caster);
    assert.equal(benefits.ritualCostModifier, -3);
    assert.equal(benefits.restlessModifier, -2);
    assert.equal(benefits.creatureBonus, 0);
    assert.equal(benefits.dreamSenses, false);
    actor.flags[SYSTEM_ID].soulBeaconUuid = beast.uuid;
    assert.equal(ritualNecromancyBonuses(actor, caster).creatureBonus, 2);
    beast.system.hp.value = 0;
    assert.equal(ritualNecromancyBonuses(actor, caster).creatureBonus, 0);
  } finally {
    globalThis.game = old;
  }
});
test('Blue Dream still applies unconscious memories after actual failed Endurance24 and enters Death State', async (t) => {
  const f = fixture(t, 'hanmarvyns-blue-dream'),
    { token } = placedActor(f.actor);
  f.actor.skillBase = () => ({ total: 5 });
  queueDice([7]);
  const corpse = { uuid: 'Actor.dead', system: { conditions: ['dead'], hp: { value: 0 } } };
  foundry.utils.fromUuid = async (uuid) => (uuid === corpse.uuid ? corpse : null);
  f.context.choices = { corpseUuid: corpse.uuid, casterTokenUuid: token.uuid };
  const result = await createRitualProcedureHandlers({ prepareSpecialMishaps() {} }).planRitualResult(
    f.context
  );
  assert.equal(result.plans[0].changes['system.hp.value'], 0);
  assert.equal(result.plans[0].changes['system.pendingDeathSaves'], 1);
  assert.ok(result.plans[0].changes['system.conditions'].includes('unconscious'));
  assert.equal(result.plans[0].changes['system.effects'][0].expires, 630);
  assert.equal(f.actor.system.hp.value, 20);
  const executed = await result.execute();
  assert.equal(executed.status, 'pendingGM');
  assert.equal(f.created[0].flags[SYSTEM_ID].magicDecision.operation.corpseUuid, corpse.uuid);
  await executed.rollback();
  assert.equal(f.created.length, 0);
});
test('Reanimate Corpse and the binding cage expose actual movement/combat restrictions without generic action penalties', () => {
  const actor = { system: { effects: [{ magic: { rule: { key: 'reanimated-corpse' } } }] } };
  assert.match(ritualActionRestriction(actor, 'move'), /Reanimate/);
  assert.match(ritualActionRestriction(actor, 'torture'), /Reanimate/);
  assert.equal(ritualActionRestriction(actor, 'resistCoercion'), null);
  actor.system.effects = [{ magic: { boundCannotAttack: true } }];
  assert.match(ritualActionRestriction(actor, 'attack'), /Binding/);
});
test('a barrier also blocks a solid attack whose two endpoints are outside but whose actual path crosses the region', () => {
  const region = {
      uuid: 'Region.r',
      flags: { [SYSTEM_ID]: { ritualArea: { active: true, type: 'barrier' } } },
      segmentizeMovementPath: () => [{ type: 'enter' }],
    },
    scene = { id: 's', regions: [region] };
  const token = (x) => ({
    parent: scene,
    getMovementOrigin: () => ({ x, y: 0, elevation: 0 }),
    testInsideRegion: () => false,
  });
  assert.match(ritualTargetingBlock(token(0), token(100), { solidEffect: true }).reason, /barrier/);
  assert.equal(ritualTargetingBlock(token(0), token(100), { solidEffect: true, teleport: true }), null);
});
