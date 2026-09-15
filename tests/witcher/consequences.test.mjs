import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fumbleKind,
  fumblePlan,
  directDamagePacket,
  commitFumble,
} from '../../module/witcher/consequences.js';
import { SYSTEM_ID } from '../../module/witcher/config.js';

const attack = (category, severity, id = 'weapon') => ({
  kind: 'attack',
  weapon: { category, id },
  check: { fumble: severity },
});
const defense = (kind, severity, weaponId = '') => ({
  kind: 'defense',
  defense: kind,
  weaponId,
  check: { fumble: severity },
});

test('p.157 unarmed parry uses the unarmed table while shield/weapon parry uses armed defense', () => {
  assert.equal(fumbleKind(defense('parry', 9)), 'unarmed');
  assert.equal(fumbleKind(defense('parry', 9, 'sword')), 'armedDefense');
  assert.equal(fumbleKind(defense('blockArm', 9)), 'unarmed');
  assert.equal(fumbleKind(defense('reposition', 9)), 'unarmed');
  assert.equal(fumbleKind(defense('blockShield', 9, 'shield')), 'armedDefense');
});

test('all physical ranged categories, including creature ranged attacks, use the ranged table', () => {
  for (const category of ['bow', 'crossbow', 'thrown', 'bomb', 'naturalRanged'])
    assert.equal(fumbleKind(attack(category, 8)), 'ranged');
  assert.equal(fumbleKind(attack('sword', 8)), 'melee');
  assert.equal(fumbleKind(attack('brawling', 8, 'unarmed')), 'unarmed');
});

test('p.157 unarmed consequences distinguish stagger, fall, save, nonlethal and lethal head impact', () => {
  assert.deepEqual(fumblePlan(defense('dodge', 6)).conditions, ['staggered']);
  assert.deepEqual(fumblePlan(defense('dodge', 7)).conditions, ['prone']);
  assert.equal(fumblePlan(defense('dodge', 7)).stunSave, false);
  assert.equal(fumblePlan(defense('dodge', 8)).stunSave, true);
  assert.deepEqual(fumblePlan(defense('parry', 9)).selfDamage, { head: true, nonlethal: true, stun: 0 });
  assert.deepEqual(fumblePlan(defense('parry', 10)).selfDamage, { head: true, nonlethal: false, stun: 0 });
});

test('p.157 armed defense keeps the four different weapon consequences', () => {
  assert.equal(fumblePlan(defense('parry', 6, 'sword')).weaponDamage, '1d6');
  assert.equal(fumblePlan(defense('parry', 7, 'sword')).dropWeapon, true);
  const fallen = fumblePlan(defense('blockShield', 8, 'shield'));
  assert.deepEqual(fallen.conditions, ['prone']);
  assert.equal(fallen.stunSave, true);
  assert.equal(fumblePlan(defense('parry', 9, 'sword')).weaponDamage, '2d6');
  assert.deepEqual(fumblePlan(defense('parry', 10, 'sword')).selfDamage, { weapon: true });
});

test('p.157 melee fumbles preserve jam, d10 wear, self hit and random ally hit', () => {
  assert.deepEqual(fumblePlan(attack('sword', 6)).conditions, ['staggered']);
  assert.equal(fumblePlan(attack('sword', 7)).jamWeapon, true);
  assert.equal(fumblePlan(attack('sword', 8)).weaponDamage, '1d10');
  assert.deepEqual(fumblePlan(attack('sword', 9)).selfDamage, { weapon: true });
  assert.equal(fumblePlan(attack('sword', 10)).allyDamage, true);
});

test('p.157 ranged fumbles do not ask for another ammunition deduction', () => {
  for (const severity of [6, 7]) {
    const plan = fumblePlan(attack('crossbow', severity));
    assert.equal(plan.projectileBroken, true);
    assert.equal(plan.weaponDamage, undefined);
  }
  for (const severity of [8, 9]) assert.equal(fumblePlan(attack('crossbow', severity)).jamWeapon, true);
  assert.equal(fumblePlan(attack('naturalRanged', 10)).allyDamage, true);
  for (const severity of [0, 1, 5]) assert.deepEqual(fumblePlan(attack('sword', severity)).conditions, []);
});

const actorData = { system: { derived: { stats: { body: 9 }, punch: '1d6+4', meleeBonus: 4 } } };
const club = {
  id: 'club',
  type: 'weapon',
  category: 'bludgeon',
  damage: '4d6',
  damageTypes: ['bludgeoning'],
  properties: { nonlethal: true },
};
test('direct damage carries explicit HP/STA choice at packet level, including nonlethal head impact', () => {
  const lethal = directDamagePacket(actorData, club);
  assert.equal(lethal.nonlethal, false);
  assert.equal(directDamagePacket(actorData, club, { nonlethal: true }).nonlethal, true);
  const head = directDamagePacket(
    actorData,
    { ...club, damage: '1d6', properties: { natural: true } },
    { nonlethal: true, location: 'head' }
  );
  assert.equal(head.aimed, 'head');
  assert.equal(head.damageFormula, '1d6');
  assert.equal(head.nonlethal, true);
});

test('a shield ricochet uses lethal shield damage rather than a placeholder formula', () => {
  const packet = directDamagePacket(actorData, {
    ...club,
    type: 'shield',
    armorClass: 'medium',
    damage: '@shieldDamage',
  });
  assert.equal(packet.damageFormula, '1d6+8');
  assert.equal(packet.weapon.properties.fixedDamage, true);
  assert.equal(packet.nonlethal, false);
});

test('a ricochet preserves the original ammunition, selected damage type and attack formula', () => {
  const ammunition = { properties: { silver: true, silverDamage: '1d6' } };
  const packet = directDamagePacket(actorData, club, {
    ammunition,
    type: 'piercing',
    damageFormula: '3d6+2',
    meleeBonus: 2,
    multiplier: 2,
    underwater: true,
  });
  assert.equal(packet.ammunition, ammunition);
  assert.equal(packet.type, 'piercing');
  assert.equal(packet.damageFormula, '3d6+2');
  assert.equal(packet.meleeBonus, 2);
  assert.equal(packet.multiplier, 2);
  assert.equal(packet.underwater, true);
});

// Persistence doubles exercise the real commitFumble/commitActor compensation paths.
// They do not simulate a live Foundry client or count as Forge acceptance.
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const put = (object, path, value) => {
  const keys = path.split('.'),
    last = keys.pop();
  let target = object;
  for (const key of keys) target = target[key] ??= {};
  target[last] = structuredClone(value);
};
function persistenceFixture() {
  globalThis.foundry = { utils: { deepClone: structuredClone, getProperty: get } };
  globalThis.ui = {
    notifications: {
      error(message) {
        throw new Error(message);
      },
    },
  };
  const actor = {
    _source: { system: { conditions: [], sta: { value: 10 }, combat: { remaining: 1, applied: [] } } },
    get system() {
      return this._source.system;
    },
    async update(changes) {
      for (const [key, value] of Object.entries(changes)) put(this._source, key, value);
    },
    items: new Map([['weapon', { id: 'weapon', _source: { system: { reliability: 15 } } }]]),
    failItemWrite: false,
    async updateEmbeddedDocuments(type, changes) {
      for (const change of changes)
        for (const [key, value] of Object.entries(change))
          if (key !== '_id') put(this.items.get(change._id)._source, key, value);
      if (this.failItemWrite) {
        this.failItemWrite = false;
        throw new Error('item write failed');
      }
    },
  };
  const source = {
    id: 'source',
    uuid: 'ChatMessage.source',
    resolved: false,
    failFlag: false,
    async setFlag(namespace, key, value) {
      if (this.failFlag) {
        this.failFlag = false;
        throw new Error('source flag failed');
      }
      this.resolved = value;
    },
  };
  return { actor, source };
}

test('failed consequences-card persistence restores wear, conditions and receipt; remaining strikes stay available', async () => {
  const { actor, source } = persistenceFixture();
  const initial = structuredClone(actor._source);
  await assert.rejects(
    commitFumble(
      actor,
      source,
      { 'system.conditions': ['prone'] },
      [{ _id: 'weapon', 'system.reliability': 12 }],
      async () => {
        throw new Error('card failed');
      }
    ),
    /card failed/
  );
  assert.deepEqual(actor._source, initial);
  assert.equal(actor.items.get('weapon')._source.system.reliability, 15);
  assert.equal(source.resolved, false);
  await commitFumble(
    actor,
    source,
    { 'system.conditions': ['prone'] },
    [{ _id: 'weapon', 'system.reliability': 12 }],
    async () => ({ uuid: 'ChatMessage.result' })
  );
  assert.equal(source.resolved, true);
  assert.equal(actor.system.combat.remaining, 1);
  assert.equal(actor.system.sta.value, 10);
});

test('retry after a failed source-message flag uses receipt and never doubles wear or creates another card', async () => {
  const { actor, source } = persistenceFixture();
  let cards = 0;
  const create = async () => {
    cards++;
    return { uuid: 'ChatMessage.result' };
  };
  source.failFlag = true;
  await assert.rejects(
    commitFumble(actor, source, {}, [{ _id: 'weapon', 'system.reliability': 12 }], create),
    /source flag failed/
  );
  assert.equal(cards, 1);
  assert.deepEqual(actor.system.combat.applied, ['fumble:source']);
  await commitFumble(actor, source, {}, [{ _id: 'weapon', 'system.reliability': 9 }], create);
  assert.equal(cards, 1);
  assert.equal(actor.items.get('weapon')._source.system.reliability, 12);
  assert.equal(source.resolved, true);
});

test('partial embedded item write is compensated before the fumble may be retried', async () => {
  const { actor, source } = persistenceFixture();
  actor.failItemWrite = true;
  await assert.rejects(
    commitFumble(
      actor,
      source,
      { 'system.conditions': ['staggered'] },
      [{ _id: 'weapon', 'system.reliability': 10 }],
      async () => assert.fail('Card must not be created')
    ),
    /item write failed/
  );
  assert.deepEqual(actor.system.conditions, []);
  assert.deepEqual(actor.system.combat.applied, []);
  assert.equal(actor.items.get('weapon')._source.system.reliability, 15);
  assert.equal(actor.system.combat.remaining, 1);
});
