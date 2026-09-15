import { SYSTEM_ID } from './config.js';
import { RuleError, beats } from './rules.js';
import { suppressed } from './monster-rules.js';
import {
  owner,
  serial,
  prompt,
  input,
  check,
  dice,
  chat,
  checkHTML,
  actionPlan,
  commitActor,
  save,
  escapeHTML as e,
} from './runtime.js';
import { measureTokenDistance, isPrimaryActiveGm, resolveFoundryUuid } from '../foundry-compat.js';
import { directWeaponDamage } from './consequences.js';

export const ACTIVE_CREATURE_ABILITIES = new Set([
  'flight',
  'swimming',
  'camouflage',
  'invisibility',
  'illusion',
  'telepathy',
  'sonicscreech',
  'dronesquills',
  'hypnosis',
  'commandtheundead',
  'ambushspecialist',
]);
const tokenFor = (actor) => actor.token?.object ?? actor.getActiveTokens()?.[0];
const effectFor = (actor, key) => actor.system.effects.find((e) => e.key === key);

function selectedTargets(actor, range) {
  const source = tokenFor(actor);
  if (!source) throw new RuleError('Place this actor on the scene first.');
  const targets = [...game.user.targets].filter((t) => t.actor && t.actor.uuid !== actor.uuid);
  if (!targets.length) throw new RuleError('Target the affected tokens first.');
  for (const token of targets) {
    const distance = measureTokenDistance(source, token);
    if (!Number.isFinite(distance) || distance > range)
      throw new RuleError(`${token.name} is outside ${range} m.`);
    owner(token.actor);
  }
  return targets.map((t) => t.actor);
}

/** Actual actions have dedicated buttons. All other entries open their printed rule. */
export async function useCreatureAbility(actor, item) {
  owner(actor);
  const key = item.system.ability.key;
  if (!ACTIVE_CREATURE_ABILITIES.has(key)) return item.sheet.render(true);
  return serial(actor.uuid, async () => {
    const name = item.name;
    if (['flight', 'swimming', 'camouflage', 'invisibility', 'illusion'].includes(key)) {
      const effectKey = {
        flight: 'Flight',
        swimming: 'Swimming',
        camouflage: 'Camouflage',
        invisibility: 'Invisibility',
        illusion: 'Illusion',
      }[key];
      const active = effectFor(actor, effectKey);
      if (active)
        return actor.update({ 'system.effects': actor.system.effects.filter((x) => x.id !== active.id) });
      if (key === 'invisibility' && suppressed(actor.system, 'Yrden'))
        throw new RuleError('Yrden prevents invisibility.');
      const fields =
        key === 'camouflage'
          ? input('home', 'In its home terrain and stationary', { type: 'checkbox' })
          : key === 'illusion'
            ? input('appearance', 'Chosen appearance', { type: 'text' })
            : ['flight', 'swimming'].includes(key)
              ? '<p>This uses your movement.</p>'
              : '';
      const values = await prompt(name, `<p>${e(item.system.effectText)}</p>` + fields);
      if (!values) return;
      if (key === 'camouflage' && !values.home)
        throw new RuleError('Camouflage requires home terrain and no movement.');
      const effect = { id: foundry.utils.randomID(), key: effectKey, sourceUuid: actor.uuid };
      if (['camouflage', 'invisibility'].includes(key)) effect.modifiers = { stealth: 10 };
      if (key === 'illusion') effect.appearance = values.appearance;
      await actor.update({ 'system.effects': [...actor.system.effects, effect] });
      return chat(actor, name, `<p>${e(effect.appearance || item.system.effectText)}</p>`);
    }
    if (key === 'telepathy') {
      const targets = selectedTargets(actor, 20);
      if (targets.length !== 1) throw new RuleError('Telepathy addresses one creature at a time.');
      const values = await prompt(name, input('message', 'Message', { type: 'text' }));
      if (values) return chat(actor, `${name} → ${targets[0].name}`, `<p>${e(values.message)}</p>`);
      return;
    }
    const range =
      key === 'sonicscreech' ? 10 : key === 'dronesquills' ? 5 : key === 'commandtheundead' ? 20 : Infinity;
    const targets = selectedTargets(actor, range);
    if (key === 'ambushspecialist') {
      const group = [...new Map([actor, ...targets].map((a) => [a.uuid, a])).values()];
      const results = [];
      for (const member of group)
        results.push({ actor: member, result: await check(member.skillBase('stealth').total) });
      const highest = results.reduce((a, b) => (a.result.total >= b.result.total ? a : b));
      return chat(
        actor,
        name,
        `<p>Group Stealth: <strong>${highest.result.total}</strong> (${e(highest.actor.name)}).</p>` +
          results.map((r) => `<p>${e(r.actor.name)}: ${r.result.total}</p>`).join(''),
        { rolls: results.flatMap((r) => r.result.rolls) }
      );
    }
    const values = await prompt(
      name,
      `<p>${e(item.system.effectText)}</p><p>Targets: ${targets.map((t) => e(t.name)).join(', ')}.</p>` +
        (key === 'commandtheundead' ? input('command', 'Command', { type: 'text' }) : '') +
        input('extra', 'Extra action: 3 STA, −3', { type: 'checkbox' })
    );
    if (!values) return;
    if (key === 'commandtheundead' && targets.some((t) => t.system.category !== 'necrophage'))
      throw new RuleError('Command the Undead affects necrophages within 20 m.');
    const plan = actionPlan(actor, { extra: values.extra });
    await commitActor(actor, plan.changes);
    if (key === 'commandtheundead')
      return chat(
        actor,
        name,
        `<p>${targets.map((t) => e(t.name)).join(', ')}: ${e(values.command)}</p><p>The controlled creatures carry out this command on their turns.</p>`
      );
    if (key === 'sonicscreech') {
      for (const target of targets) await save(target, 'stun', { modifier: -1 });
      return;
    }
    if (key === 'hypnosis') {
      const roll = await check(actor.skillBase('spellCasting', { modifier: plan.modifier }).total);
      await chat(actor, name, checkHTML(roll), { rolls: roll.rolls });
      for (const target of targets) {
        const defense = await check(target.skillBase('resistMagic').total);
        await chat(target, 'Resist Hypnosis', checkHTML(defense), { rolls: defense.rolls });
        if (!beats(roll.total, defense.total)) continue;
        await target.update({
          'system.effects': [
            ...target.system.effects.filter((x) => !(x.key === 'Hypnosis' && x.sourceUuid === actor.uuid)),
            {
              id: foundry.utils.randomID(),
              key: 'Hypnosis',
              sourceUuid: actor.uuid,
              expires: game.time.worldTime + 15,
            },
          ],
        });
      }
      return;
    }
    if (key === 'dronesquills') {
      for (const target of targets) {
        const shield = target.items.find(
          (i) => i.type === 'shield' && i.system.equipped && i.system.reliability > 0
        );
        const choice = await prompt(
          `${target.name}: quills`,
          input('defense', 'Defense against DC 15', {
            options: { dodge: 'Dodge / Escape', ...(shield ? { shield: 'Block with ' + shield.name } : {}) },
          })
        );
        if (!choice)
          throw new RuleError('Resolve this defense before continuing. The drone action has been spent.');
        const defensePlan = actionPlan(target, { defense: true });
        const roll = await check(
          target.skillBase(choice.defense === 'shield' ? 'melee' : 'dodge', {
            modifier: choice.defense === 'shield' ? shield.system.accuracy : 0,
          }).total
        );
        await commitActor(target, defensePlan.changes);
        await chat(target, 'Endrega quills: defense', checkHTML(roll), { rolls: roll.rolls });
        const diceCount = Math.max(0, 15 - roll.total);
        if (!diceCount) continue;
        await directWeaponDamage(actor, target, {
          name: 'Drone’s Quills',
          damage: `${diceCount}d6`,
          damageTypes: ['piercing'],
          properties: { natural: true, fixedDamage: true, poison: 100 },
        });
        await target.setCondition('poison').catch((error) => {
          if (!target.system.immunities.includes('poison')) throw error;
        });
      }
    }
  });
}

export async function escapeWeb(actor) {
  owner(actor);
  return serial(actor.uuid, async () => {
    const web = effectFor(actor, 'Webbing');
    if (!web) throw new RuleError('This actor is not caught in arachas webbing.');
    const plan = actionPlan(actor, { recovery: true });
    const result = await check(actor.skillBase('physique', { modifier: plan.modifier }).total);
    const escaped = beats(result.total, web.dc);
    await actor.update({
      ...plan.changes,
      ...(escaped
        ? {
            'system.effects': actor.system.effects.filter((x) => x.id !== web.id),
            'system.conditions': actor.system.conditions.filter((c) => c !== 'grappled'),
          }
        : {}),
    });
    return chat(
      actor,
      'Break webbing',
      checkHTML(result) +
        `<p>${escaped ? 'Free of the webbing.' : `Still grappled (DC ${web.dc}); the webbing can also be destroyed with 10 damage.`}</p>`,
      { rolls: result.rolls }
    );
  });
}

export async function rollCreatureLoot(actor) {
  owner(actor);
  if (!game.user.isGM) throw new RuleError('The GM rolls creature loot.');
  return serial(actor.uuid, async () => {
    if (actor.system.bestiary.lootGenerated)
      throw new RuleError('Loot has already been generated for this actor.');
    const rows = [],
      rolls = [],
      items = [];
    let coins = actor.system.coins;
    for (const entry of actor.system.bestiary.loot ?? []) {
      if (entry.inInventory) {
        rows.push(`${entry.name}: already in inventory`);
        continue;
      }
      const roll = await dice(entry.formula);
      rolls.push(roll);
      const quantity = Math.max(0, Math.floor(roll.total));
      rows.push(`${entry.name}: ${quantity}`);
      if (!quantity) continue;
      if (/^crowns$/i.test(entry.name)) {
        coins += quantity;
        continue;
      }
      if (entry.uuid) {
        const source = await resolveFoundryUuid(entry.uuid);
        if (!source) throw new RuleError(`Missing loot item: ${entry.name}`);
        const data = source.toObject();
        delete data._id;
        data.system.quantity = quantity;
        data.system.equipped = false;
        items.push(data);
      }
    }
    const created = await actor.createEmbeddedDocuments('Item', items);
    try {
      await actor.update({ 'system.coins': coins, 'system.bestiary.lootGenerated': true });
    } catch (error) {
      await actor.deleteEmbeddedDocuments(
        'Item',
        created.map((i) => i.id)
      );
      throw error;
    }
    return chat(
      actor,
      'Loot',
      rows.map((row) => `<p>${e(row)}</p>`).join('') +
        '<p>Named stock was added to inventory. Generic mundane/random items require a GM choice.</p>',
      { rolls }
    );
  });
}

export function registerCreatureAbilities() {
  Hooks.on('updateToken', (token, changes) => {
    if (!isPrimaryActiveGm() || !['x', 'y', 'elevation'].some((k) => k in changes) || !token.actor) return;
    const actor = token.actor;
    if (effectFor(actor, 'Camouflage'))
      serial(actor.uuid, () =>
        actor.update({ 'system.effects': actor.system.effects.filter((x) => x.key !== 'Camouflage') })
      ).catch(console.error);
  });
}
