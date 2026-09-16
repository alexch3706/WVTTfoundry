import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Handlebars from 'handlebars';
import { woundDisplay, woundModifierRows } from '../../module/witcher/wound-display.js';
import { woundItemData } from '../../module/witcher/wound-catalog.js';
import { HUMANOID_LOCATIONS } from '../../module/witcher/config.js';

const hbs = Handlebars.create();
hbs.registerHelper('checked', (value) => (value ? 'checked' : ''));
const itemTemplate = hbs.compile(
  fs.readFileSync(new URL('../../templates/witcher/item.hbs', import.meta.url), 'utf8')
);
const actorTemplate = hbs.compile(
  fs.readFileSync(new URL('../../templates/witcher/actor.hbs', import.meta.url), 'utf8')
);
const item = (key, changes = {}) => ({ id: `wound-${key}`, ...woundItemData({ key, ...changes }) });
function owner(wounds, { body = 7, conditions = [], locations = HUMANOID_LOCATIONS } = {}) {
  return {
    isOwner: true,
    items: wounds,
    system: { stats: { body }, hp: { value: 35 }, conditions, locations },
  };
}
const render = (i, view) =>
  itemTemplate({ item: i, system: i.system, isWound: true, wound: view }).replace(/\s+/g, ' ');

test('compendium wound card explains application and complete care without inventory fields or state edits', () => {
  const i = item('complex-0');
  const before = structuredClone(i);
  const view = woundDisplay(i);
  assert.equal(view.owned, false);
  assert.deepEqual(view.requirements, { dc: 14, rounds: 4, magicDC: 16, magicUses: 6 });
  assert.equal(view.recoveryTable.length, 11);
  assert.equal(view.recoveryTable[0].body, 3);
  assert.equal(view.recoveryTable.at(-1).body, 13);
  const html = render(i, view);
  assert.match(html, /Drag this Item onto a character or NPC sheet/);
  assert.match(html, /successful applications against DC 16/);
  assert.match(html, /Effects by stage/);
  assert.doesNotMatch(
    html,
    /<h2>Inventory|name='system\.(quantity|weight|equipped|wound\.(treatment|daysRemaining))'/
  );
  assert.doesNotMatch(html, /data-witcher='wound'/);
  assert.deepEqual(i, before);
});

test('legacy wound without a saved key or inner name retains the canonical stage explanations', () => {
  const injury = item('simple-0');
  delete injury.system.wound.key;
  delete injury.system.wound.name;
  const view = woundDisplay(injury, { actor: owner([injury]), isGM: true });
  assert.match(render(injury, view), /Effects by stage/);
  assert.equal(view.stages.length, 4);
  assert(view.stages.every((stage) => stage.text));
});

test('owned preview uses the BODY after treatment and labels the actual chosen anatomy', () => {
  const i = item('simple-3', { location: 'carapace' }); // Cracked Ribs: untreated BODY −2, treated ENC only.
  const actor = owner([i], { locations: [{ id: 'carapace', label: 'Carapace', group: 'torso' }] });
  const view = woundDisplay(i, { actor, isGM: true });
  assert.equal(view.location, 'Carapace');
  assert.equal(view.recoveryBody, 7);
  assert.match(view.recovery, /1 day after successful treatment \(BODY 7\)/);
  assert.equal(view.canMedical, true);
  assert.equal(view.canMarkStabilized, true);
  assert(view.modifiers.some((row) => row.label === 'BODY' && row.value === '-2'));
  const html = actorTemplate({ actor, system: actor.system, wounds: [view] }).replace(/\s+/g, ' ');
  assert.match(html, /data-wound-stage='untreated'/);
  assert.match(html, /Cracked Ribs/);
  assert.match(html, /Medicine DC 12/);
  assert.match(html, /data-key='markStabilized'/);
});

test('players can request medicine and advance a running recovery clock, while manual state and spell controls are GM-only', () => {
  const i = item('complex-4', { location: 'head', magicUses: 2, turnsTreated: 3, extraResult: 6 });
  const actor = owner([i]);
  const player = woundDisplay(i, { actor });
  const html = render(i, player);
  assert.equal(player.canMedical, true);
  assert.equal(player.canMarkTreated, false);
  assert.equal(player.canMagic, false);
  assert.match(html, /Recorded: 2 \/ 6/);
  assert.match(html, /Recorded: 3 \/ 4 rounds/);
  assert.match(html, /1d10 result: <strong>6<\/strong>/);
  assert.doesNotMatch(html, /data-key='markTreated'|data-key='magic'/);
  i.system.wound.treatment = 'treated';
  i.system.wound.daysRemaining = 4;
  i.system.wound.daysTotal = 5;
  const treated = woundDisplay(i, { actor });
  assert.equal(treated.canDays, true);
  assert.equal(treated.canMedical, false);
  assert.match(treated.recovery, /4 days remaining of 5/);
  assert.equal(woundDisplay(i, { actor, isOwner: false, isGM: true }).canDays, false);
});

test('zero days with a pending GM ruling is never displayed as a completed recovery', () => {
  const i = item('simple-2', {
    location: 'torso',
    treatment: 'treated',
    recoveryPending: true,
    daysRemaining: 0,
  });
  const actor = owner([i]);
  const player = woundDisplay(i, { actor });
  assert.equal(player.canDays, false);
  assert.equal(player.recovery, 'GM recovery time required.');
  assert.match(player.recoveryReason, /Critical Healing/);
  const gm = woundDisplay(i, { actor, isGM: true });
  assert.equal(gm.canDays, true);
  assert.equal(gm.daysLabel, 'Set recovery time (GM)');
  assert.doesNotMatch(render(i, gm), /0 days remaining|Recovery complete/);
});

test('healed permanent consequences remain visible, healed ordinary wounds retain history, and fatal wounds offer no cure', () => {
  const lostArm = item('deadly-1', { location: 'leftArm', treatment: 'healed' });
  const permanent = woundDisplay(lostArm, { actor: owner([lostArm]), isGM: true });
  assert.match(permanent.stageLabel, /lasting consequence/);
  assert(permanent.modifiers.some((row) => row.value === 'Unusable'));
  assert.match(permanent.activeText, /Permanent consequence/);
  assert.equal(permanent.canDays, false);
  const teeth = item('complex-4', { treatment: 'healed', extraResult: 8 });
  const healed = woundDisplay(teeth, { actor: owner([teeth]) });
  assert.deepEqual(healed.modifiers, []);
  assert.equal(healed.extraResult, 8);
  assert.match(healed.activeText, /history/);
  const fatal = item('deadly-5');
  const view = woundDisplay(fatal, { actor: owner([fatal]), isGM: true });
  const html = render(fatal, view);
  assert.match(html, /Fatal injury/);
  assert.doesNotMatch(html, /data-witcher='wound'|successful applications against|0 days remaining/);
  assert.deepEqual(view.recoveryTable, []);
});

test('legacy conditions are explained without clearing unrelated conditions; contextual limb and sight penalties are identified', () => {
  const i = item('deadly-4', { separateConditions: false, location: 'head' });
  const actor = owner([i], { conditions: ['bleeding'] });
  const before = structuredClone(actor);
  const view = woundDisplay(i, { actor });
  assert.match(view.legacyNotice, /separately marked Bleeding/);
  assert(view.contextual.some((text) => text.includes('only to checks using sight')));
  assert.deepEqual(actor, before);
  const arm = item('simple-1', { location: 'rightArm' });
  assert(woundDisplay(arm).contextual.some((text) => text.includes('relevant limb')));
  assert.deepEqual(woundModifierRows({ headMultiplier: 4, armDisabled: 1, allActions: -2 }), [
    { key: 'headMultiplier', label: 'Damage to the head', value: '×4' },
    { key: 'armDisabled', label: 'Injured limb', value: 'Unusable' },
    { key: 'allActions', label: 'All actions', value: '-2' },
  ]);
});

test('injury notes and custom reference text render as text without HTML injection', () => {
  const i = {
    id: 'custom',
    name: 'Custom <injury>',
    system: {
      effectText: '<img src=x onerror=alert(1)>',
      wound: {
        name: 'Custom injury',
        severity: 'simple',
        treatment: 'treated',
        location: 'head',
        notes: '</textarea><script>alert(1)</script>',
        daysRemaining: 2,
      },
    },
  };
  const view = woundDisplay(i, { actor: owner([i]) });
  const html = render(i, view);
  assert.equal(view.known, false);
  assert.match(html, /Custom injury: the core wound catalog/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
});
