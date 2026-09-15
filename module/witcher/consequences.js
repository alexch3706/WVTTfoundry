import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { itemSnapshot } from './documents.js';
import { prepareDamage, damageHTML } from './combat.js';
import {
  actorFromUuid,
  dice,
  chat,
  save,
  input,
  prompt,
  serial,
  escapeHTML as e,
  errorNotice,
  actionPlan,
  commitActor,
} from './runtime.js';
import { isPrimaryActiveGm, measureTokenDistance } from '../foundry-compat.js';

export async function directWeaponDamage(
  attacker,
  target,
  weapon,
  { location = '', nonlethal = false, multiplier = 1, stun = null } = {}
) {
  const packet = {
    weapon: { ...weapon, properties: { ...weapon.properties, nonlethal } },
    aimed: location,
    type: weapon.damageTypes?.[0] ?? 'bludgeoning',
    multiplier,
    meleeBonus: attacker.system.derived.meleeBonus,
    cover: 0,
  };
  const damage = await prepareDamage(attacker, target, packet);
  return chat(
    attacker,
    `${weapon.name} → ${target.name}`,
    damageHTML(damage) + '<button type="button" data-witcher-action="apply">Apply damage (GM)</button>',
    {
      rolls: damage.rolls,
      flags: {
        kind: 'damage',
        actorUuid: attacker.uuid,
        targetUuid: target.uuid,
        request: damage.request,
        wound: null,
        conditions: damage.conditions,
        effects: damage.effects,
        stun,
        summary: damage.results,
        state: damage.state,
        applied: false,
      },
    }
  );
}

export async function resolveFumble(message) {
  if (!isPrimaryActiveGm()) throw new RuleError('The active GM applies combat fumble consequences.');
  return serial('gm-fumbles', async () => {
    const data = message.flags[SYSTEM_ID];
    const severity = data?.check?.fumble ?? 0;
    if (severity <= 5 || data.fumbleResolved) return;
    const actor = await actorFromUuid(data.actorUuid);
    if (!actor?.testUserPermission(message.author, 'OWNER'))
      throw new RuleError('The roll author does not own this actor.');
    const defense = data.kind === 'defense';
    let weapon = defense ? actor.items.get(data.weaponId) : actor.items.get(data.weapon?.id);
    const kind = defense
      ? ['parry', 'blockWeapon', 'blockShield'].includes(data.defense)
        ? 'armedDefense'
        : 'unarmed'
      : data.weapon.id === 'unarmed'
        ? 'unarmed'
        : ['bow', 'crossbow', 'thrown', 'bomb'].includes(data.weapon.category)
          ? 'ranged'
          : 'melee';
    const rolls = [];
    let text = '';
    const damageWeapon = async (formula) => {
      if (!weapon) return;
      const roll = await dice(formula);
      rolls.push(roll);
      let damage = roll.total;
      if (weapon.system.attachments.some((a) => a.name === 'Chemobog')) {
        const protection = await dice('1d6');
        rolls.push(protection);
        if (protection.total >= 4) damage = 0;
      }
      await weapon.update({ 'system.reliability': Math.max(0, weapon.system.reliability - damage) });
      text = `${weapon.name} loses ${damage} reliability.`;
    };
    const dropWeapon = async () => {
      if (!weapon) return;
      const distance = await dice('1d6'),
        direction = await dice('1d10');
      rolls.push(distance, direction);
      await weapon.update({ 'system.equipped': false, 'system.carried': false });
      text = `${weapon.name} drops ${distance.total} m away; scatter ${direction.total}.`;
    };
    if (kind === 'unarmed') {
      if (severity === 6) {
        await actor.setCondition('staggered');
        text = 'Staggered.';
      } else {
        await actor.setCondition('prone');
        text = 'Prone.';
        if (severity >= 9)
          await directWeaponDamage(
            actor,
            actor,
            {
              id: 'fall',
              name: 'Fumble: head impact',
              damage: '1d6',
              damageTypes: ['bludgeoning'],
              properties: { natural: true },
            },
            { location: 'head', nonlethal: severity === 9, stun: 0 }
          );
        else if (severity === 8) await save(actor, 'stun');
      }
    } else if (kind === 'melee') {
      if (severity === 6) {
        await actor.setCondition('staggered');
        text = 'Staggered.';
      }
      if (severity === 7 && weapon) {
        await weapon.update({ 'system.jammed': true });
        text = 'Weapon stuck; one full round to free it.';
      }
      if (severity === 8) await damageWeapon('1d10');
      if (severity === 9)
        await directWeaponDamage(actor, actor, data.weapon, { multiplier: data.multiplier });
    } else if (kind === 'armedDefense') {
      if (severity === 6) await damageWeapon('1d6');
      if (severity === 7) await dropWeapon();
      if (severity === 8) {
        await actor.setCondition('prone');
        await save(actor, 'stun');
        text = 'Prone.';
      }
      if (severity === 9) await damageWeapon('2d6');
      if (severity > 9 && weapon) await directWeaponDamage(actor, actor, itemSnapshot(weapon));
    } else if (kind === 'ranged') {
      if (severity <= 7) {
        // The fired unit was already deducted by the attack. The remaining stack is not damaged.
        text = 'The fired ammunition / thrown weapon breaks.';
      } else if (severity <= 9 && weapon) {
        if (['thrown', 'bomb'].includes(weapon.system.category)) {
          text = 'Thrown weapon dropped at your feet.';
        } else {
          await weapon.update({ 'system.jammed': true });
          text = 'Weapon jammed / bowstring loose; one full round to restore it.';
        }
      }
    }
    if (severity > 9 && ['melee', 'ranged'].includes(kind)) {
      const token = actor.token?.object ?? actor.getActiveTokens()[0];
      const range =
        kind === 'melee'
          ? 2
          : data.weapon.rangeBodyMultiplier
            ? data.weapon.rangeBodyMultiplier * actor.system.derived.stats.body
            : data.weapon.range * 2;
      const nearby = (canvas.tokens?.placeables ?? []).filter(
        (t) => t.actor && t.actor.uuid !== actor.uuid && (measureTokenDistance(token, t) ?? Infinity) <= range
      );
      const content =
        '<p>Select the allies within range. One is chosen randomly.</p>' +
        nearby
          .map((t) =>
            input(t.id, t.name, {
              type: 'checkbox',
              checked: t.document.disposition === token?.document.disposition,
            })
          )
          .join('');
      const choice = await prompt('Fumble: nearby ally', content, { button: 'Roll random ally' });
      if (!choice) throw new RuleError('Ally selection cancelled; this fumble is still pending.');
      const allies = nearby.filter((t) => choice[t.id]);
      if (allies.length) {
        const die = await dice(`1d${allies.length}`);
        rolls.push(die);
        await directWeaponDamage(actor, allies[die.total - 1].actor, data.weapon, {
          multiplier: data.multiplier,
        });
      } else text = 'No ally within range.';
    }
    await message.setFlag(SYSTEM_ID, 'fumbleResolved', true);
    await chat(
      actor,
      'Fumble consequences',
      `<p>${e(text || 'Damage card created for the additional hit.')}</p>`,
      { rolls }
    );
  });
}

export function registerConsequences() {
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const data = message.flags[SYSTEM_ID];
    if (
      !['attack', 'defense'].includes(data?.kind) ||
      !data.check?.fumble ||
      data.check.fumble <= 5 ||
      data.fumbleResolved
    )
      return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Apply fumble (GM)';
    button.addEventListener('click', () => resolveFumble(message).catch(errorNotice));
    html.querySelector('.witcher-chat')?.append(button);
  });
}
