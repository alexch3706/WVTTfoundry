/** View rendering and UI orchestration tests. Injected dialog/command adapters
 * exercise cancellation and payloads; they are not a running Foundry instance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Handlebars from 'handlebars';
import { SYSTEM_ID } from '../../module/witcher/config.js';
import { magicInfo, magicItemData } from '../../module/witcher/magic-catalog.js';
import { magicCostPlan } from '../../module/witcher/magic-rules.js';
import { IMPLEMENTED_MAGIC } from '../../module/witcher/magic-state.js';
import { workflow } from './workflow-fixture.mjs';
import {
  castMagic,
  defendMagic,
  magicActorDisplay,
  magicItemDisplay,
  applyUIaction,
} from '../../module/witcher/magic-ui.js';

Handlebars.registerHelper('checked', (value) => (value ? 'checked' : ''));
const compiled = Handlebars.compile(
  fs.readFileSync(new URL('../../templates/witcher/magic.hbs', import.meta.url), 'utf8')
);
const template = (data) => compiled(data).replace(/\s+/g, ' ');
const magicCard = Handlebars.compile(
  fs.readFileSync(new URL('../../templates/witcher/magic-item.hbs', import.meta.url), 'utf8')
);
const itemSheet = Handlebars.compile(
  fs.readFileSync(new URL('../../templates/witcher/item.hbs', import.meta.url), 'utf8')
);
const actorSheet = Handlebars.compile(
  fs.readFileSync(new URL('../../templates/witcher/actor.hbs', import.meta.url), 'utf8')
);
const item = (key) => ({ id: key, ...magicItemData(key) });
const actor = (items = [], overrides = {}) => ({
  uuid: 'Actor.caster',
  name: 'Caster',
  isOwner: true,
  items,
  system: {
    magic: { tradition: 'witcher', coneAngle: 90, roundKey: '', spent: 0 },
    vigor: 7,
    sta: { value: 20, max: 30 },
    hp: { value: 30, max: 30 },
    luck: { value: 2 },
    skills: {},
    effects: [],
    conditions: [],
    anatomy: 'humanoid',
    ...overrides,
  },
});

function globals(t, values) {
  const before = new Map(
    Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  Object.assign(globalThis, values);
  t.after(() => {
    for (const [key, descriptor] of before)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
}

test('magic views import and render without Foundry document classes', () => {
  const source = item('quen'),
    view = magicItemDisplay(source);
  assert.equal(view.implemented, true);
  assert.equal(view.canCast, false);
  assert.equal(view.owned, false);
  assert.match(view.hint, /Drag this Item/);
  assert.match(view.costLabel, /1–7/);
  assert.equal(view.rangeLabel, 'Self');
});

test('the real item sheet renders a dedicated magic card without equipment controls', () => {
  const source = item('igni'),
    magic = magicItemDisplay(source);
  const html = itemSheet({
    item: source,
    system: source.system,
    isMagic: true,
    magicCard: magicCard({ magic, system: source.system }),
  }).replace(/\s+/g, ' ');
  assert.match(html, /Sign · Basic/);
  assert.match(html, /50% ignition/);
  assert.match(html, /printed p.114/);
  assert.match(html, /name='system.notes'/);
  assert.doesNotMatch(html, /<h2>Inventory|name='system.quantity'|name='system.magic.cost/);
  assert.doesNotMatch(html, /data-witcher='magicCast'/);
  const owner = actor([source]),
    ownedView = magicItemDisplay(source, { actor: owner });
  assert.match(magicCard({ magic: ownedView, system: source.system }), /data-witcher='magicCast'/);
});

test('the real actor sheet includes the rendered Magic tab and its effect controls', () => {
  const owner = actor([item('quen')]),
    magic = magicActorDisplay(owner);
  const html = actorSheet({ actor: owner, system: owner.system, magicPanel: template({ magic }) }).replace(
    /\s+/g,
    ' '
  );
  assert.match(html, /data-tab='magic'>Magic<\/a>/);
  assert.match(html, /data-tab='magic'><section class='witcher-magic'>/);
  assert.match(html, /data-witcher='magicCast' data-item-id='quen'/);
  assert.match(html, /name='system.professionRanks.heliotrope'/);
});

test('actor sheet context renders actual learning projects and the available glide action', async (t) => {
  const w = await workflow(t);
  foundry.appv1 = {
    sheets: {
      ActorSheet: class {
        async getData() {
          return { actor: this.actor };
        }
      },
      ItemSheet: class {
        async getData() {
          return { item: this.item };
        }
      },
    },
  };
  foundry.applications = {
    handlebars: {
      renderTemplate: async (path, data) => {
        assert.match(path, /magic\.hbs$/);
        return template(data);
      },
    },
  };
  await w.attacker.update({
    'system.ip': 12,
    'system.magic': {
      tradition: 'mage',
      magicIP: 7,
      learning: [
        {
          id: 'study',
          name: 'Learn Aenye',
          status: 'studying',
          successes: 1,
          requirements: { checks: 2 },
          readyAt: 90,
          nextCheckAt: 0,
          source: { description: 'Teacher' },
        },
      ],
    },
    'system.effects': [
      {
        id: 'glide',
        magic: {
          key: 'adenydd',
          operation: { type: 'modifier', rule: { key: 'glide', horizontalMetresPerMetreFallen: 1 } },
        },
      },
    ],
  });
  w.attacker.system.locationTable = w.attacker.system.locations;
  const { WitcherActorSheet } = await import('../../module/witcher/sheets.js');
  const sheet = new WitcherActorSheet();
  sheet.actor = w.attacker;
  const view = await sheet.getData({});
  assert.match(view.magicPanel, /Ordinary IP: 12 · Magic-only IP: 7/);
  assert.match(view.magicPanel, /Learn Aenye/);
  assert.match(view.magicPanel, /data-effect-id='study'/);
  assert.match(view.magicPanel, /data-witcher='glide'/);
});

test('the Magic tab offers casting only for runtime-supported learned entries', () => {
  const source = item('quen'),
    reference = {
      id: 'reference',
      type: 'magic',
      name: 'Unimplemented custom spell',
      system: { magic: { key: 'unknown', kind: 'spell' }, effectText: 'Reference only' },
    };
  const owner = actor([source, reference]),
    view = magicActorDisplay(owner),
    html = template({ magic: view });
  assert.equal(view.known.length, 1);
  assert.equal(view.references.length, 1);
  assert.equal(view.known[0].canCast, true);
  assert.match(html, /data-witcher='magicCast' data-item-id='quen'/);
  assert.doesNotMatch(html, /data-witcher='magicCast' data-item-id='reference'/);
  assert.match(html, /Reference — effect not automated/);
  assert(IMPLEMENTED_MAGIC.has('quen'));
  assert(IMPLEMENTED_MAGIC.has('aenye'));
  assert(!IMPLEMENTED_MAGIC.has('unknown'));
  assert.equal(magicItemDisplay(item('dispel'), { actor: owner }).canCast, false);
  assert.match(magicItemDisplay(item('dispel'), { actor: owner }).hint, /casting card/);
});

test('round expenditure displays only the current combat round and dimeritium changes actual Vigor', () => {
  const owner = actor([], {
    vigor: 7,
    magic: { tradition: 'witcher', spent: 6, roundKey: 'combat:3', dimeritiumUnits: 2 },
  });
  const combat = { id: 'combat', round: 3, started: true };
  const view = magicActorDisplay(owner, { combat });
  assert.equal(view.vigor, 5);
  assert.equal(view.spent, 6);
  assert.equal(view.remainingVigor, 0);
  assert.equal(magicActorDisplay(owner, { combat: { ...combat, round: 4 } }).spent, 0);
  assert.equal(magicActorDisplay(owner, { combat: null }).spent, 0);
  owner.system.magic.dimeritiumContact = true;
  assert.equal(magicActorDisplay(owner, { combat }).vigor, 0);
  assert.match(magicActorDisplay(owner).preparationHint, /No Vigor/);
});

test('focus choices show only held eligible items and preserve Griffin-only Witcher rules', () => {
  const focus = (id, data = {}) => ({
    id,
    name: id,
    type: 'weapon',
    system: { quantity: 1, equipped: true, carried: true, properties: { focus: 1 }, ...data },
  });
  const owner = actor([
    focus('griffin', { witcherWeapon: true, school: 'Griffin' }),
    focus('ordinary'),
    focus('packed', { witcherWeapon: true, school: 'Griffin', equipped: false }),
  ]);
  assert.deepEqual(
    magicActorDisplay(owner).focuses.map((row) => row.id),
    ['griffin']
  );
  owner.system.magic.tradition = 'mage';
  assert.deepEqual(
    magicActorDisplay(owner).focuses.map((row) => row.id),
    ['griffin', 'ordinary']
  );
});

test('active effects display current shield HP, fractional upkeep and recovery actions', () => {
  const owner = actor([], {
    effects: [
      {
        id: 'shield',
        key: 'Active Shield',
        shieldHP: 7,
        expires: 0,
        magic: { key: 'active-shield', casterEffect: true, maintenance: 'initial', staCost: 3 },
      },
      {
        id: 'stream',
        key: 'Fire Stream',
        expires: 0,
        magic: { key: 'fire-stream', casterEffect: true, maintenance: 'half', staCost: 3 },
      },
      { id: 'axii', key: 'Axii', expires: 0, magic: { key: 'axii', stunModifier: -2 } },
      { id: 'control', key: 'Puppet', expires: 12, magic: { key: 'puppet' } },
    ],
  });
  const view = magicActorDisplay(owner, { time: 6, isGM: false }),
    html = template({ magic: view });
  assert.equal(view.effects[0].shieldHP, 7);
  assert.equal(view.effects[1].maintenance, 1.5);
  assert.equal(view.effects[2].canResist, true);
  assert.equal(view.effects[2].canEnd, false, 'a victim cannot dismiss hostile magic');
  assert.equal(view.effects[3].durationLabel, '6 seconds remaining');
  assert.match(html, /Current shield HP: 7/);
  assert.match(html, /Maintain for 1.5 STA/);
  assert.match(html, /data-effect-id='axii' data-key='resist'/);
});

test('view generation is immutable and Handlebars escapes actor/item strings', () => {
  const source = item('quen');
  source.name = '<img src=x onerror=alert(1)>';
  const owner = actor([source], {
    effects: [
      { id: 'hostile', key: '<script>bad()</script>', notes: '<svg onload=bad()>', magic: { key: 'axii' } },
    ],
  });
  const before = structuredClone(owner),
    html = template({ magic: magicActorDisplay(owner) });
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x|<svg onload/);
  assert.deepEqual(owner, before);
});

function castFixture(t, key, answers, { power = 3, vigor = 7, preview = undefined } = {}) {
  const magicItem = item(key),
    owner = actor([magicItem], { vigor });
  const scene = { id: 'scene', tokens: new Map() },
    token = {
      id: 'caster-token',
      uuid: 'Scene.scene.Token.caster',
      name: 'Caster token',
      actor: owner,
      parent: scene,
    };
  scene.tokens.set(token.id, token);
  owner.getActiveTokens = () => [token];
  globals(t, {
    game: { user: { isGM: true, targets: new Set() }, time: { worldTime: 0 }, combat: null },
    canvas: { scene, tokens: { controlled: [token] } },
  });
  const prompts = [],
    commands = [],
    calls = [];
  const api = {
    learnedMagic: () => ({ item: magicItem, magic: magicInfo(key) }),
    magicFingerprint: () => 'fingerprint',
    resolve: async (uuid) => (uuid === token.uuid ? token : undefined),
    prompt: async (title, content, options) => {
      prompts.push({ title, content });
      const answer = answers.shift();
      if (answer) options?.validate?.(answer);
      return answer ?? null;
    },
    magicAreaSpec: () =>
      ['igni', 'aard'].includes(key) ? { shape: 'cone', angle: 90, angleSource: 'table' } : null,
    previewMagicRegion: async () => {
      calls.push('preview');
      return preview === undefined
        ? { origin: {}, placement: {}, targetIds: [], candidates: [], warnings: [] }
        : preview;
    },
    actionPlan: () => ({ changes: {}, modifier: 0, cost: 0 }),
    magicSpending: (caster, magic, amount, options) => ({
      cost: magicCostPlan({
        magic,
        power: amount,
        focus: 0,
        spent: 0,
        vigor: caster.system.vigor,
        stamina: caster.system.sta.value,
      }),
    }),
    magicTokenDistance: () => 1,
    runCommand: async (name, payload) => {
      commands.push({ name, payload });
      return payload;
    },
  };
  return {
    owner,
    magicItem,
    token,
    scene,
    api,
    prompts,
    commands,
    calls,
    config: {
      power: String(power),
      modifier: '0',
      luck: '0',
      manualDice: '',
      focusId: '',
      extra: false,
      forfeit: false,
    },
  };
}

test('cancelling cast configuration never places a region or submits a command', async (t) => {
  const f = castFixture(t, 'igni', [null]);
  assert.equal(await castMagic(f.owner, f.magicItem, { services: f.api }), null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.commands, []);
  assert.equal(f.owner.system.sta.value, 20);
});

test('cancelling the native area preview leaves the actor and authority queue untouched', async (t) => {
  const answers = [],
    f = castFixture(t, 'igni', answers, { preview: null });
  answers.push(f.config);
  assert.equal(await castMagic(f.owner, f.magicItem, { services: f.api }), null);
  assert.deepEqual(f.calls, ['preview']);
  assert.deepEqual(f.commands, []);
  assert.equal(f.owner.system.sta.value, 20);
});

test('cancelling final target/cost review does not cast or spend resources', async (t) => {
  const answers = [],
    f = castFixture(t, 'igni', answers);
  answers.push(f.config, null);
  await castMagic(f.owner, f.magicItem, { services: f.api });
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1].content, /3 STA/);
  assert.match(f.prompts[1].content, /Cone angle: 90°/);
  assert.deepEqual(f.commands, []);
});

test('confirmed casting submits one frozen turn/fingerprint and the actual preview to authority', async (t) => {
  const preview = {
    origin: { x: 5 },
    placement: { x: 5, rotation: 40 },
    targetIds: ['victim'],
    candidates: [{ tokenId: 'victim', name: '<Victim>', included: true }],
    warnings: ['Explicit area convention'],
  };
  const answers = [],
    f = castFixture(t, 'aard', answers, { preview });
  answers.push(f.config, {});
  await castMagic(f.owner, f.magicItem, { services: f.api });
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0].name, 'magicCast');
  const payload = f.commands[0].payload;
  assert.equal(payload.expected, 'fingerprint');
  assert.equal(payload.turn, '');
  assert.equal(payload.tokenUuid, f.token.uuid);
  assert.equal(payload.values.power, 3);
  assert.equal(payload.area, preview);
  assert.match(f.prompts[1].content, /&lt;Victim&gt;/);
  assert.equal(f.owner.system.sta.value, 20, 'UI submits; authoritative handler performs the spend');
});

test('overexertion cannot pass final review without the explicit checkbox', async (t) => {
  const answers = [],
    f = castFixture(t, 'quen', answers, { vigor: 2 });
  answers.push(f.config, { overdraw: false });
  await assert.rejects(castMagic(f.owner, f.magicItem, { services: f.api }), /Explicitly accept/);
  assert.match(f.prompts[1].content, /5 HP/);
  assert.deepEqual(f.commands, []);
});

test('manual die validation fails before any placement or resource command', async (t) => {
  const answers = [],
    f = castFixture(t, 'igni', answers);
  answers.push({ ...f.config, manualDice: '10' });
  await assert.rejects(castMagic(f.owner, f.magicItem, { services: f.api }), /next d10/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.commands, []);
});

test('multiple caster tokens require an explicit choice instead of choosing the first', async (t) => {
  const f = castFixture(t, 'quen', [null]);
  const second = { ...f.token, id: 'second', uuid: 'Scene.scene.Token.second', name: 'Second caster' };
  globalThis.canvas.tokens.controlled = [f.token, second];
  await castMagic(f.owner, f.magicItem, { services: f.api });
  assert.equal(f.prompts[0].title, 'Choose casting token');
  assert.match(f.prompts[0].content, /Second caster/);
  assert.deepEqual(f.commands, []);
});

test('magical defense includes Athletics and excludes broken or unequipped block gear', async (t) => {
  const f = castFixture(t, 'igni', [null]);
  const victim = actor([
    { id: 'broken', type: 'shield', name: 'Broken shield', system: { equipped: true, reliability: 0 } },
  ]);
  victim.uuid = 'Actor.victim';
  f.api.actorFromUuid = async () => victim;
  const message = {
    uuid: 'ChatMessage.magic',
    flags: {
      [SYSTEM_ID]: {
        name: 'Igni',
        magic: magicInfo('igni'),
        check: { total: 18 },
        targets: [{ tokenUuid: 'Token.victim', actorUuid: victim.uuid }],
      },
    },
  };
  await defendMagic(message, 'Token.victim', { services: f.api });
  assert.match(f.prompts[0].content, /value="athletics"/);
  assert.doesNotMatch(f.prompts[0].content, /value="block"/);
  assert.match(f.prompts[0].content, /Accept the magic/);
  assert.deepEqual(f.commands, []);
});

test('ending Active Shield requires review of its collapse consequence', async (t) => {
  const f = castFixture(t, 'quen', [null]);
  await applyUIaction(
    f.owner,
    { id: 'effect', key: 'Active Shield', magic: { key: 'active-shield' } },
    'end',
    { services: f.api }
  );
  assert.match(f.prompts[0].content, /releases its damage and push/);
  assert.deepEqual(f.commands, []);
});

test('the actual magic Item sheet renders through the V14 template API and protects canonical rules on submit', async (t) => {
  const baseSheet = class {
    async getData() {
      return { item: this.item };
    }
  };
  globals(t, {
    Actor: class {},
    Item: class {},
    game: { user: { isGM: true } },
    foundry: {
      abstract: { TypeDataModel: class {} },
      data: { fields: {} },
      appv1: { sheets: { ActorSheet: baseSheet, ItemSheet: baseSheet } },
      utils: { expandObject: (data) => structuredClone(data) },
      applications: {
        handlebars: {
          renderTemplate: async (path, data) => {
            assert.equal(path, `systems/${SYSTEM_ID}/templates/witcher/magic-item.hbs`);
            return magicCard(data);
          },
        },
      },
    },
  });
  const { WitcherItemSheet } = await import('../../module/witcher/sheets.js');
  const source = item('quen'),
    updates = [];
  source.update = async (patch) => {
    updates.push(patch);
    return patch;
  };
  const context = { item: source };
  const view = await WitcherItemSheet.prototype.getData.call(context, {});
  assert.equal(view.isMagic, true);
  assert.equal(view.inventoryItem, undefined);
  assert.match(view.magicCard, /Casting supported/);
  await WitcherItemSheet.prototype._updateObject.call(context, null, {
    name: 'Personal Quen name',
    img: 'icons/test.webp',
    system: {
      notes: 'Personal note',
      quantity: 100,
      equipped: true,
      magic: { cost: { min: 0 }, effect: { params: { shieldHPPerSTA: 999 } } },
    },
  });
  assert.deepEqual(updates, [
    { name: 'Personal Quen name', img: 'icons/test.webp', 'system.notes': 'Personal note' },
  ]);
});
