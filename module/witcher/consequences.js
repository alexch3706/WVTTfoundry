import { SYSTEM_ID } from './config.js';
import { RuleError, shieldStrike, weaponDamageFormula } from './rules.js';
import {
  actorFromUuid,
  dice,
  chat,
  input,
  prompt,
  escapeHTML as e,
  errorNotice,
  commitActor,
} from './runtime.js';
import { registerCommand, runCommand } from './authority.js';
import { isPrimaryActiveGm, measureTokenDistance } from '../foundry-compat.js';

const itemSnapshot = (item) => ({ id: item.id, type: item.type, name: item.name, ...item.system.toObject() });
const ranged = ['bow', 'crossbow', 'thrown', 'bomb', 'naturalRanged'];

/** p.157: a parry without a weapon is an unarmed defense. */
export function fumbleKind(data) {
  if (data.kind === 'defense')
    return ['blockWeapon', 'blockShield'].includes(data.defense) ||
      (data.defense === 'parry' && !!data.weaponId)
      ? 'armedDefense'
      : 'unarmed';
  if (data.kind !== 'attack') throw new RuleError('Only an attack or defense can have a combat fumble.');
  return data.weapon?.id === 'unarmed'
    ? 'unarmed'
    : ranged.includes(data.weapon?.category)
      ? 'ranged'
      : 'melee';
}

/** Book-based consequences; dice and document writes happen only after GM authorization. */
export function fumblePlan(data) {
  const severity = Number(data.check?.fumble ?? 0),
    kind = fumbleKind(data);
  if (!Number.isInteger(severity) || severity < 0) throw new RuleError('Invalid fumble severity.');
  const plan = { kind, severity, conditions: [], stunSave: false };
  if (severity <= 5) return plan;
  if (kind === 'unarmed') {
    plan.conditions.push(severity === 6 ? 'staggered' : 'prone');
    plan.stunSave = severity === 8;
    if (severity >= 9) plan.selfDamage = { head: true, nonlethal: severity === 9, stun: 0 };
  } else if (kind === 'melee') {
    if (severity === 6) plan.conditions.push('staggered');
    if (severity === 7) plan.jamWeapon = true;
    if (severity === 8) plan.weaponDamage = '1d10';
    if (severity === 9) plan.selfDamage = { weapon: true };
    if (severity > 9) plan.allyDamage = true;
  } else if (kind === 'armedDefense') {
    if (severity === 6) plan.weaponDamage = '1d6';
    if (severity === 7) plan.dropWeapon = true;
    if (severity === 8) {
      plan.conditions.push('prone');
      plan.stunSave = true;
    }
    if (severity === 9) plan.weaponDamage = '2d6';
    if (severity > 9) plan.selfDamage = { weapon: true };
  } else {
    if (severity <= 7) plan.projectileBroken = true;
    else if (severity <= 9) plan.jamWeapon = true;
    else plan.allyDamage = true;
  }
  return plan;
}

export function directDamagePacket(
  attacker,
  weapon,
  {
    location = '',
    nonlethal = false,
    multiplier = 1,
    ammunition = null,
    type,
    damageFormula,
    meleeBonus,
    underwater = false,
  } = {}
) {
  const prepared =
    weapon.type === 'shield' ? shieldStrike(weapon, attacker.system.derived.stats.body) : weapon;
  return {
    weapon: prepared,
    damageFormula:
      damageFormula ??
      weaponDamageFormula(prepared, {
        punch: attacker.system.derived.punch,
        body: attacker.system.derived.stats.body,
      }),
    nonlethal: !!nonlethal,
    ammunition,
    underwater,
    aimed: location,
    type: type ?? prepared.damageTypes?.[0] ?? 'bludgeoning',
    multiplier,
    meleeBonus: meleeBonus ?? attacker.system.derived.meleeBonus,
    cover: 0,
  };
}

async function directDamageCard(attacker, target, weapon, options = {}) {
  const { prepareDamage, damageHTML } = await import('./combat.js');
  const damage = await prepareDamage(attacker, target, directDamagePacket(attacker, weapon, options));
  return {
    title: `${weapon.name} → ${target.name}`,
    content:
      damageHTML(damage) + '<button type="button" data-witcher-action="apply">Apply damage (GM)</button>',
    rolls: damage.rolls,
    flags: {
      kind: 'damage',
      actorUuid: attacker.uuid,
      targetUuid: target.uuid,
      request: damage.request,
      wound: null,
      conditions: damage.conditions,
      effects: damage.effects,
      stun: options.stun ?? damage.stun ?? null,
      summary: damage.results,
      state: damage.state,
      applied: false,
    },
  };
}

export async function directWeaponDamage(attacker, target, weapon, options = {}) {
  const card = await directDamageCard(attacker, target, weapon, options);
  return chat(attacker, card.title, card.content, { rolls: card.rolls, flags: card.flags });
}

function nearbyAllies(actor, data) {
  const token = actor.token?.object ?? actor.getActiveTokens()[0];
  const range =
    fumbleKind(data) === 'melee'
      ? Math.max(2, data.weapon.range ?? 0)
      : data.weapon.rangeBodyMultiplier
        ? data.weapon.rangeBodyMultiplier * actor.system.derived.stats.body
        : Number(data.weapon.range) * 2;
  return (canvas.tokens?.placeables ?? []).filter(
    (t) => t.actor && t.actor.uuid !== actor.uuid && (measureTokenDistance(token, t) ?? Infinity) <= range
  );
}

export async function resolveFumble(message) {
  if (!game.user.isGM) throw new RuleError('The GM applies combat fumble consequences.');
  const data = message.flags[SYSTEM_ID];
  let allies = [],
    naturalRuling = '';
  const fumbleActor = await actorFromUuid(data.actorUuid);
  const fumbleWeapon = fumbleActor?.items.get(data.kind === 'defense' ? data.weaponId : data.weapon?.id);
  if (!data.fumbleResolved && fumblePlan(data).dropWeapon && fumbleWeapon?.system.properties.natural) {
    const choice = await prompt(
      'Natural weapon fumble: GM ruling',
      '<p>The armed-defense table says to drop the weapon. The supplied rules give no replacement for an attached claw or tail. Apply any chosen consequence on the sheet, then record your ruling here; the natural weapon will not be dropped.</p>' +
        input('ruling', 'GM ruling', { type: 'text' }),
      { button: 'Record ruling' }
    );
    if (!choice) return;
    naturalRuling = choice.ruling.trim();
    if (!naturalRuling)
      throw new RuleError('Record the GM ruling before resolving this natural-weapon fumble.');
  }
  if (!data.fumbleResolved && fumblePlan(data).allyDamage) {
    const actor = await actorFromUuid(data.actorUuid),
      nearby = nearbyAllies(actor, data);
    const token = actor.token?.object ?? actor.getActiveTokens()[0];
    if (nearby.length) {
      const choice = await prompt(
        'Fumble: nearby ally',
        '<p>Select allies within range. One is chosen randomly.</p>' +
          nearby
            .map((t) =>
              input(t.id, t.name, {
                type: 'checkbox',
                checked: t.document.disposition === token?.document.disposition,
              })
            )
            .join(''),
        { button: 'Roll random ally' }
      );
      if (!choice) return;
      allies = nearby.filter((t) => choice[t.id]).map((t) => t.document.uuid);
    }
  }
  return runCommand(
    'resolveFumble',
    { messageUuid: message.uuid, allies, naturalRuling },
    { label: 'Apply combat fumble' }
  );
}

/** The receipt and resource changes commit together; a failed final source flag is safe to retry. */
export async function commitFumble(actor, source, changes, itemChanges, createCard) {
  const receipt = `fumble:${source.id}`;
  if (actor.system.combat.applied.includes(receipt)) {
    await source.setFlag(SYSTEM_ID, 'fumbleResolved', true);
    return source;
  }
  const result = await commitActor(
    actor,
    { ...changes, 'system.combat.applied': [...actor.system.combat.applied, receipt] },
    itemChanges,
    createCard
  );
  await source.setFlag(SYSTEM_ID, 'fumbleResolved', true);
  return result;
}

async function performFumble({ messageUuid, allies = [], naturalRuling = '' }, { user }) {
  if (!user.isGM || !isPrimaryActiveGm())
    throw new RuleError('Only a GM can apply combat fumble consequences.');
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags[SYSTEM_ID];
  if (!message?.author?.isGM) throw new RuleError('This is not a GM-authorized combat result.');
  if (!data) throw new RuleError('The fumble message no longer exists.');
  const plan = fumblePlan(data);
  if (plan.severity <= 5 || data.fumbleResolved) return message;
  const actor = await actorFromUuid(data.actorUuid);
  const author = data.authorId ? game.users.get(data.authorId) : message.author;
  if (!actor || !author || !actor.testUserPermission(author, 'OWNER'))
    throw new RuleError('The original roll author no longer owns this actor.');
  if (actor.system.combat.applied.includes(`fumble:${message.id}`)) {
    await message.setFlag(SYSTEM_ID, 'fumbleResolved', true);
    return game.messages.find((entry) => entry.flags[SYSTEM_ID]?.fumbleSource === message.uuid) ?? message;
  }
  const weapon = actor.items.get(data.kind === 'defense' ? data.weaponId : data.weapon?.id);
  if (
    (plan.weaponDamage ||
      plan.dropWeapon ||
      plan.jamWeapon ||
      (plan.selfDamage?.weapon && data.kind === 'defense')) &&
    !weapon
  )
    throw new RuleError(
      'The weapon used for this fumble is no longer in the actor inventory; restore it before resolving.'
    );
  if (plan.weaponDamage && weapon.system.properties.natural && weapon.system.maxReliability <= 0)
    throw new RuleError(
      'The Core book does not list this natural weapon’s Reliability. Set its current and maximum Reliability before applying weapon damage (Journal p.12).'
    );
  const conditions = new Set([...actor.system.conditions, ...plan.conditions]);
  const changes = {},
    itemChanges = [],
    rolls = [],
    text = [];
  if (plan.conditions.length) text.push(plan.conditions.join(', ') + '.');
  if (plan.weaponDamage) {
    const rolled = await dice(plan.weaponDamage);
    rolls.push(rolled);
    let wear = rolled.total;
    itemChanges.push({ _id: weapon.id, 'system.reliability': Math.max(0, weapon.system.reliability - wear) });
    text.push(`${weapon.name} loses ${wear} reliability.`);
  }
  if (plan.dropWeapon && weapon.system.properties.natural) {
    if (!String(naturalRuling).trim())
      throw new RuleError('A natural weapon cannot be dropped; record a GM ruling.');
    text.push(`Natural-weapon fumble, GM ruling: ${naturalRuling}`);
  } else if (plan.dropWeapon) {
    const distance = await dice('1d6'),
      direction = await dice('1d10');
    rolls.push(distance, direction);
    itemChanges.push({ _id: weapon.id, 'system.equipped': false, 'system.carried': false });
    text.push(`${weapon.name} drops ${distance.total} m away; scatter ${direction.total}.`);
  }
  if (plan.jamWeapon) {
    itemChanges.push({ _id: weapon.id, 'system.jammed': true });
    text.push(
      ['thrown', 'bomb', 'naturalRanged'].includes(weapon.system.category)
        ? 'The projectile is dropped; spend one full round restoring this attack.'
        : 'Weapon stuck, jammed or bowstring loose; spend one full round restoring it.'
    );
  }
  if (plan.projectileBroken)
    text.push('The fired projectile or thrown unit breaks. No second ammunition deduction.');
  if (plan.stunSave) {
    const stun = await dice('1d10');
    rolls.push(stun);
    const success = stun.total < actor.system.derived.stun;
    if (success) conditions.delete('stunned');
    else conditions.add('stunned');
    text.push(`Stun save ${stun.total} < ${actor.system.derived.stun}: ${success ? 'passed' : 'failed'}.`);
  }
  changes['system.conditions'] = [...conditions];
  let card;
  if (plan.selfDamage?.head)
    card = await directDamageCard(
      actor,
      actor,
      {
        id: 'fall',
        name: 'Fumble: head impact',
        type: 'weapon',
        category: 'natural',
        damage: '1d6',
        damageTypes: ['bludgeoning'],
        properties: { natural: true, fixedDamage: true, environmental: true },
      },
      { location: 'head', nonlethal: plan.selfDamage.nonlethal, stun: 0 }
    );
  else if (plan.selfDamage?.weapon)
    card = await directDamageCard(
      actor,
      actor,
      data.kind === 'defense' ? itemSnapshot(weapon) : data.weapon,
      { ...data, location: '', multiplier: data.multiplier ?? 1, nonlethal: !!data.nonlethal }
    );
  if (plan.allyDamage) {
    const nearby = nearbyAllies(actor, data),
      valid = nearby.filter((token) => allies.includes(token.document.uuid));
    if (allies.some((uuid) => !nearby.some((token) => token.document.uuid === uuid)))
      throw new RuleError('An ally moved out of reach; choose the fumble target again.');
    if (valid.length) {
      const die = await dice(`1d${valid.length}`);
      rolls.push(die);
      card = await directDamageCard(actor, valid[die.total - 1].actor, data.weapon, {
        ...data,
        location: '',
        multiplier: data.multiplier ?? 1,
        nonlethal: !!data.nonlethal,
      });
    } else text.push('No ally within range.');
  }
  const content = `<p>${e(text.join(' ') || 'Resolve the additional hit below.')}</p>${card?.content ?? ''}`;
  return commitFumble(actor, message, changes, itemChanges, () =>
    chat(actor, 'Fumble consequences', content, {
      rolls: [...rolls, ...(card?.rolls ?? [])],
      flags: { ...(card?.flags ?? { kind: 'fumble' }), fumbleSource: message.uuid },
    })
  );
}

export function registerConsequences() {
  registerCommand('resolveFumble', performFumble);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const data = message.flags[SYSTEM_ID];
    if (
      !game.user.isGM ||
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
