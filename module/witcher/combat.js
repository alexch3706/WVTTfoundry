import { SYSTEM_ID, SKILLS, SPECIAL_ACTIONS } from './config.js';
import {
  RuleError,
  locate,
  hitLocations,
  strikeProfile,
  weaponDamageBonus,
  weaponDamageFormula,
  shieldStrike,
  rangeBracket,
  defenseModifier,
  criticalSeverity,
  resolveDamage,
  beats,
} from './rules.js';
import { adjustSchoolCritical, schoolReactions } from './school-gear.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { validateWeaponGrip } from './inventory.js';
import { criticalWound, fumbleText } from './wounds.js';
import { woundItemData } from './wound-catalog.js';
import { resolveWoundArm, woundCheckModifier } from './wound-rules.js';
import { rangeDifficulty } from './advanced-rules.js';
import { immuneTo, locationChoices, crushingForce, suppressed, isIncorporeal } from './monster-rules.js';
import { actorSnapshot, itemSnapshot, staminaCapChanges } from './documents.js';
import { measureTokenDistance, isPrimaryActiveGm } from '../foundry-compat.js';
import {
  owner,
  prompt,
  input,
  manualCheckInput,
  woundArmInput,
  validateManualCheck,
  check,
  dice,
  chat,
  checkHTML,
  escapeHTML as e,
  actionPlan,
  turnIdentity,
  commitActor,
  serial,
  actorFromUuid,
  save,
  errorNotice,
} from './runtime.js';

const RANGED = ['bow', 'crossbow', 'thrown', 'bomb', 'naturalRanged'];
const NO_DAMAGE = ['disarm', 'takeWeapon', 'trip', 'grapple', 'pin', 'choke', 'escape', 'feint'];
const titleCase = (text) => text.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
const snapshotRoll = (result) => ({
  base: result.base,
  dice: result.dice,
  total: result.total,
  fumble: result.fumble,
  source: result.source,
});
const has = (actor, status) => actor.system.conditions.includes(status);
const tokenFor = (actor) => actor.token?.object ?? actor.getActiveTokens()?.[0];

function combatModifier(actor, { defense = false, melee = false } = {}) {
  let result = 0;
  const reasons = [];
  for (const [status, value] of [
    ['prone', -2],
    ['staggered', -2],
    ['blinded', -3],
  ])
    if (has(actor, status)) {
      result += value;
      reasons.push(`${status} ${value}`);
    }
  const env = actor.system.environment;
  if (env.light === 'dark' && !actor.system.effects.some((x) => x.key === 'Cat')) {
    result -= 2;
    reasons.push('darkness -2');
  }
  if (env.light === 'bright') {
    result -= 3;
    reasons.push('facing bright light -3');
  }
  if (env.underwater && melee && !actor.system.traits.amphibious) {
    result -= 2;
    reasons.push('underwater -2');
  }
  if (!defense && actor.system.effects.some((x) => x.key === 'Invisibility')) {
    result += 5;
    reasons.push('invisibility +5');
  }
  return { modifier: result, reasons };
}
function unarmed(actor, action) {
  return {
    id: 'unarmed',
    name: titleCase(action),
    type: 'weapon',
    category: 'brawling',
    skill: 'brawling',
    stat: 'ref',
    hands: 1,
    reliability: 1,
    damage:
      action === 'kick' || action === 'pushKick' ? actor.system.derived.kick : actor.system.derived.punch,
    damageTypes: ['bludgeoning'],
    accuracy: 0,
    rof: 1,
    properties: { nonlethal: true, natural: true },
  };
}
function selectedToken(actor) {
  const combatToken = game.combat?.combatant?.token?.object;
  return (
    actor.token?.object ??
    canvas.tokens?.controlled.find((t) => t.actor?.uuid === actor.uuid) ??
    (combatToken?.actor?.uuid === actor.uuid ? combatToken : tokenFor(actor))
  );
}
async function tokenFromUuid(uuid, actor) {
  if (!uuid) return selectedToken(actor);
  const doc = await foundry.utils.fromUuid(uuid);
  if (doc?.actor?.uuid !== actor.uuid)
    throw new RuleError('The selected token no longer belongs to this actor.');
  return doc.object;
}
function meleeDistance(source, target) {
  if (!source || !target || !canvas.grid?.measurePath) return undefined;
  // Measure between the nearest occupied cell centres, including large-token footprints.
  const unit = canvas.dimensions.size;
  const nearest = (token, other) => ({
    x: Math.max(token.x + unit / 2, Math.min(other.center.x, token.x + token.w - unit / 2)),
    y: Math.max(token.y + unit / 2, Math.min(other.center.y, token.y + token.h - unit / 2)),
  });
  return canvas.grid.measurePath([nearest(source, target), nearest(target, source)]).distance;
}
function weaponFor(actor, item, action = 'normal') {
  if (!item) return unarmed(actor, action === 'normal' ? 'punch' : action);
  const snapshot = itemSnapshot(item);
  if (['bow', 'crossbow'].includes(snapshot.category)) {
    const ammo = actor.items.get(snapshot.ammoId);
    if (ammo?.system.isAmmo && ammo.system.damageTypes?.length)
      snapshot.damageTypes = [...ammo.system.damageTypes];
  }
  return item.type === 'shield' ? shieldStrike(snapshot, actor.system.derived.stats.body) : snapshot;
}
function defenseButtons(target) {
  let html =
    '<div class="action-bar"><button type="button" data-witcher-action="defend" data-defense="dodge">Dodge</button>';
  for (const item of target.items.filter(
    (i) =>
      ['weapon', 'shield'].includes(i.type) &&
      i.system.equipped &&
      i.system.quantity > 0 &&
      (i.system.reliability > 0 || i.system.properties.natural)
  )) {
    html += `<button type="button" data-witcher-action="defend" data-defense="${item.type === 'shield' ? 'blockShield' : 'blockWeapon'}" data-weapon="${e(item.id)}">Block: ${e(item.name)}</button>`;
    html += `<button type="button" data-witcher-action="defend" data-defense="parry" data-weapon="${e(item.id)}">Parry: ${e(item.name)}</button>`;
  }
  return html + '<button type="button" data-witcher-action="defend">Other defense / DC</button></div>';
}
export async function attack(actor, item, options = {}) {
  owner(actor);
  const targetToken = options.targetTokenUuid
    ? await tokenFromUuid(options.targetTokenUuid, options.target)
    : options.target
      ? selectedToken(options.target)
      : [...game.user.targets][0];
  const target = options.target ?? targetToken?.actor;
  const sourceToken = options.sourceTokenUuid
    ? await tokenFromUuid(options.sourceTokenUuid, actor)
    : selectedToken(actor);
  const expectedTurn = turnIdentity();
  if (!target) throw new RuleError('Target a token before attacking.');
  if (actor.system.armorError) throw new RuleError(actor.system.armorError);
  const weapon = options.weapon ?? weaponFor(actor, item, options.action ?? 'punch');
  if (weapon.type !== 'weapon') throw new RuleError('Choose a weapon or an unarmed attack.');
  const minor = actor.type !== 'character' && !actor.system.majorNpc;
  const ranged = RANGED.includes(weapon.category);
  const table = hitLocations(actorSnapshot(target));
  const continuing =
    actor.system.combat.remaining > 0 &&
    actor.system.combat.weaponId === weapon.id &&
    (!game.combat?.started ||
      actor.system.combat.key === `${game.combat.id}:${game.combat.round}:${game.combat.turn}`);
  const distance = ranged
    ? measureTokenDistance(sourceToken, targetToken)
    : meleeDistance(sourceToken, targetToken);
  const fields =
    `<p>${e(actor.name)} → ${e(target.name)} · ${e(weapon.name)}</p>` +
    input('style', 'Strike', {
      value:
        options.style ??
        (continuing
          ? actor.system.combat.style
          : minor || weapon.category === 'crossbow'
            ? 'normal'
            : 'fast'),
      options:
        minor || weapon.category === 'crossbow'
          ? { normal: 'Normal / ROF' }
          : { fast: 'Fast', strong: 'Strong', normal: 'Single' },
    }) +
    input('action', 'Action', {
      value: options.action ?? 'normal',
      options: Object.fromEntries(
        (options.reactionId ? [options.action ?? 'normal'] : ['normal', 'punch', 'kick']).map((k) => [
          k,
          titleCase(k),
        ])
      ),
    }) +
    input('location', 'Aim at location', {
      value: '',
      options: {
        '': 'Random',
        ...Object.fromEntries(locationChoices(table).map((l) => [l.id, `${l.label} (${l.aim})`])),
      },
    }) +
    input('type', 'Damage type', {
      value: weapon.damageTypes?.[0] ?? 'bludgeoning',
      options: Object.fromEntries(
        (weapon.damageTypes?.length ? weapon.damageTypes : ['bludgeoning']).map((t) => [t, titleCase(t)])
      ),
    }) +
    (ranged ? input('distance', 'Distance (metres)', { value: distance ?? '', min: 0, step: 0.1 }) : '') +
    (weapon.properties?.nonlethal && weapon.id !== 'unarmed'
      ? input('nonlethal', 'Deal non-lethal damage (STA)', { type: 'checkbox' })
      : '') +
    input('forfeit', 'Forfeit unused strikes to start a different action', { type: 'checkbox' }) +
    input('cover', 'Cover stopping power', { value: 0, min: 0 }) +
    input('modifier', 'Other attack modifiers', { value: 0 }) +
    input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value }) +
    input('extra', 'Extra action: 3 STA, −3', { type: 'checkbox' }) +
    input('outside', 'Target outside your vision cone (−3; no aiming)', { type: 'checkbox' }) +
    input('rear', 'You are outside the defender’s vision cone (+3)', { type: 'checkbox' }) +
    input('ambush', 'Successful ambush in the first round (+5, p.153)', { type: 'checkbox' }) +
    woundArmInput(actor, { optional: !!weapon.properties?.natural }) +
    manualCheckInput();
  const values =
    options.values ??
    (await prompt('Attack', fields, {
      button: continuing ? 'Next strike' : 'Attack',
      width: 510,
      validate: validateManualCheck,
    }));
  if (!values) return;
  return runCommand(
    'attack',
    {
      actorUuid: actor.uuid,
      targetUuid: target.uuid,
      itemId: item?.id,
      sourceTokenUuid: sourceToken?.document.uuid,
      targetTokenUuid: targetToken?.document.uuid,
      values,
      expectedTurn,
      reactionId: options.reactionId,
      reactionChoice: options.reactionChoice,
    },
    { label: `${actor.name}: ${weapon.name}` }
  );
}
async function executeAttack(payload, context) {
  const actor = await authorizedActor(payload.actorUuid, context.user);
  const target = await actorFromUuid(payload.targetUuid);
  if (!target) throw new RuleError('Target no longer exists.');
  const item = payload.itemId ? actor.items.get(payload.itemId) : null;
  if (payload.itemId && !item) throw new RuleError('The weapon is no longer in your inventory.');
  const values = payload.values;
  const weapon = weaponFor(actor, item, values.action);
  const sourceToken = await tokenFromUuid(payload.sourceTokenUuid, actor);
  const targetToken = await tokenFromUuid(payload.targetTokenUuid, target);
  const minor = actor.type !== 'character' && !actor.system.majorNpc;
  const table = hitLocations(actorSnapshot(target));
  const distance = RANGED.includes(weapon.category)
    ? measureTokenDistance(sourceToken, targetToken)
    : meleeDistance(sourceToken, targetToken);
  if (actor.system.armorError) throw new RuleError(actor.system.armorError);
  for (const key of ['modifier', 'luck', 'cover'])
    if (!Number.isFinite(Number(values[key] ?? 0))) throw new RuleError('Invalid numeric attack choice.');
  let { action, style, location } = values;
  const reaction = payload.reactionId
    ? actor.system.combat.reactions.find((r) => r.id === payload.reactionId)
    : null;
  const reactionChoice = reaction?.choices.find((c) => c.key === payload.reactionChoice);
  if (payload.reactionId && (!reaction || !reactionChoice || reaction.turn !== turnIdentity()))
    throw new RuleError('This immediate reaction has expired or was already used.');
  if (reaction) {
    action = reactionChoice.action;
    style = 'normal';
    if (reactionChoice.targetConstraint === 'triggeringAttacker' && target.uuid !== reaction.opponentUuid)
      throw new RuleError('This shield strike targets the attacker who triggered it.');
    if (
      reactionChoice.weaponRequirement === 'manticoreShield' &&
      !(item?.type === 'shield' && item.system.school === 'manticore')
    )
      throw new RuleError('Choose the Manticore Shield.');
  }
  if (!['normal', 'punch', 'kick'].includes(action) && !(reaction && ['trip', 'disarm'].includes(action)))
    throw new RuleError('Unknown combat action.');
  if (!(weapon.damageTypes?.length ? weapon.damageTypes : ['bludgeoning']).includes(values.type))
    throw new RuleError('Choose a damage type provided by this weapon.');
  if (Number(values.cover) < 0) throw new RuleError('Cover SP cannot be negative.');
  if (values.outside && location) throw new RuleError('You cannot aim outside your vision cone.');
  const w = [
    'punch',
    'kick',
    'pushKick',
    'grapple',
    'pin',
    'choke',
    'throw',
    'takeWeapon',
    'escape',
  ].includes(action)
    ? unarmed(actor, action)
    : weapon;
  if (w.id !== 'unarmed' && !w.consumable && !item.system.equipped)
    throw new RuleError('Equip this weapon first.');
  if (w.reliability <= 0 && (!w.properties?.natural || w.maxReliability > 0))
    throw new RuleError('This weapon is broken.');
  if (item?.system.jammed) throw new RuleError('Free or unjam this weapon before attacking.');
  if (item && (item.system.quantity < 1 || (!w.properties?.natural && !item.system.carried)))
    throw new RuleError('Carry at least one of this item before using it.');
  const grip = validateWeaponGrip(actorSnapshot(actor), w, actorSnapshot(actor).items);
  const injuryArm = resolveWoundArm(
    actor.system,
    [...actor.items],
    values.woundArm,
    ['kick', 'pushKick', 'escape', 'feint'].includes(action)
      ? 'none'
      : grip.hands === 2
        ? 'both'
        : action === 'punch' || !w.properties?.natural
          ? 'one'
          : 'optional'
  );
  if (w.properties?.minimumDistance && !(distance > w.properties.minimumDistance))
    throw new RuleError(`This ability requires a target farther than ${w.properties.minimumDistance} m.`);
  if (w.name === 'Charge' && actor.system.category === 'elementa' && suppressed(actor.system, 'Dimeritium'))
    throw new RuleError('Dimeritium suppresses this charge.');
  if (['pin', 'choke', 'throw'].includes(action) && actor.system.combat.grappling !== target.uuid)
    throw new RuleError('You must grapple this target first.');
  if (action === 'escape' && actor.system.combat.grappledBy !== target.uuid)
    throw new RuleError('Target the actor grappling you.');
  const plan = reaction
    ? {
        ...actionPlan(actor, { reaction: true, expectedTurn: payload.expectedTurn }),
        profile: { attacks: 1, modifier: 0, multiplier: 1 },
      }
    : actionPlan(actor, {
        weapon: w,
        style,
        action,
        npc: minor,
        extra: !!values.extra,
        forfeit: !!values.forfeit,
        full: !!w.properties?.fullRound,
        expectedTurn: payload.expectedTurn,
        underwater: actor.system.environment.underwater && !actor.system.traits.amphibious,
      });
  const profile = plan.profile;
  const changes = { ...plan.changes };
  if (reaction)
    changes['system.combat.reactions'] = actor.system.combat.reactions.filter((r) => r.id !== reaction.id);
  const luck = Number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  const situational = combatModifier(actor, { melee: !RANGED.includes(w.category) });
  let modifier =
    Number(values.modifier) +
    luck +
    profile.modifier +
    plan.modifier +
    Number(w.accuracy ?? 0) +
    grip.modifier +
    situational.modifier;
  const reasons = [
    ...situational.reasons,
    `accuracy ${w.accuracy ?? 0}`,
    `grip ${grip.modifier}`,
    `style ${profile.modifier}`,
    `extra action ${plan.modifier}`,
    `situational ${values.modifier}`,
    `Luck ${luck}`,
    ...(injuryArm
      ? [`${injuryArm}: arm injury ${woundCheckModifier([...actor.items], { arm: injuryArm })}`]
      : []),
  ];
  if (location) {
    modifier += locate(table, location).aim;
    reasons.push(`aim ${locate(table, location).aim}`);
  }
  if (values.outside) modifier -= 3;
  if (values.rear) modifier += 3;
  if (values.ambush) modifier += 5;
  if (has(target, 'activelyDodging') && !RANGED.includes(w.category)) modifier -= 2;
  if (has(target, 'pinned')) modifier += 4;
  if (target.system.effects.some((x) => x.key === 'Invisibility')) modifier -= 3;
  if (actor.system.effects.some((x) => x.key === 'Hypnosis' && x.sourceUuid === target.uuid)) modifier -= 4;
  if (action === 'takeWeapon') modifier -= 3;
  let range = null;
  if (RANGED.includes(w.category)) {
    if (w.category === 'naturalRanged' && Number(values.distance) > w.range)
      throw new RuleError(`This ability reaches at most ${w.range} m.`);
    const rangeValue =
      (w.rangeBodyMultiplier ? w.rangeBodyMultiplier * actor.system.derived.stats.body : w.range) /
      (actor.system.environment.underwater && w.category !== 'naturalRanged' ? 4 : 1);
    const measuredRange = distance ?? Number(values.distance);
    if (!Number.isFinite(measuredRange) || measuredRange < 0)
      throw new RuleError('Enter a valid target distance.');
    range = rangeBracket(measuredRange, rangeValue);
    modifier += range.modifier + actor.system.combat.aim;
    reasons.push(`${range.name} ${range.modifier}`, `aiming ${actor.system.combat.aim}`);
    if (actor.system.environment.underwater && w.category === 'thrown' && !/spear/i.test(w.name))
      throw new RuleError('Only spears can be thrown underwater (p.165).');
  } else if (
    distance !== undefined &&
    distance > Math.max(2, w.range || 0) &&
    action !== 'charge' &&
    !w.properties?.minimumDistance
  ) {
    throw new RuleError('Target is outside melee reach.');
  }
  const itemChanges = [];
  let ammunition = null;
  if (['bow', 'crossbow'].includes(w.category)) {
    const ammo = actor.items.get(item.system.ammoId);
    if (
      !ammo?.system.isAmmo ||
      !ammo.system.carried ||
      ammo.system.quantity < 1 ||
      !['projectile', w.category].includes(ammo.system.ammoCategory)
    )
      throw new RuleError('Select ammunition with at least one remaining unit on the weapon sheet.');
    if (w.category === 'crossbow' && !item.system.loaded)
      throw new RuleError('Reload the crossbow first (one action).');
    ammunition = itemSnapshot(ammo);
    itemChanges.push({ _id: ammo.id, 'system.quantity': ammo.system.quantity - 1 });
    if (w.category === 'crossbow') itemChanges.push({ _id: item.id, 'system.loaded': false });
  } else if (w.category === 'thrown' || w.consumable) {
    if (item.system.quantity < 1) throw new RuleError('No items remain to throw.');
    itemChanges.push({
      _id: item.id,
      'system.quantity': item.system.quantity - 1,
      ...(item.system.quantity <= 1 ? { 'system.equipped': false } : {}),
    });
  }
  const skill = action === 'feint' ? 'deceit' : action === 'escape' ? 'dodge' : w.skill;
  const result = await check(
    actor.skillBase(skill, {
      stat: action === 'feint' ? 'emp' : action === 'escape' ? 'ref' : w.stat,
      modifier,
      arm: injuryArm,
    }).total,
    { manualDice: values.manualDice }
  );
  changes['system.luck.value'] = actor.system.luck.value - luck;
  changes['system.combat.aim'] = 0;
  const packet = {
    kind: 'attack',
    authorId: context.user.id,
    operationId: context.id,
    sourceTokenUuid: payload.sourceTokenUuid ?? '',
    targetTokenUuid: payload.targetTokenUuid ?? '',
    schoolOnHit: reactionChoice?.onHit ?? null,
    nonlethal: w.id === 'unarmed' || (!!w.properties?.nonlethal && !!values.nonlethal),
    damageFormula: weaponDamageFormula(w, {
      punch: actor.system.derived.punch,
      body: actor.system.derived.stats.body,
    }),
    actorUuid: actor.uuid,
    targetUuid: target.uuid,
    weapon: w,
    ammunition,
    action,
    style,
    aimed: location,
    type: values.type,
    cover: Number(values.cover),
    multiplier: profile.multiplier,
    meleeBonus: actor.system.derived.meleeBonus,
    range,
    underwater: actor.system.environment.underwater,
    check: snapshotRoll(result),
    resolved: false,
    invisible: actor.system.effects.some((x) => x.key === 'Invisibility'),
  };
  if (packet.invisible)
    changes['system.effects'] = actor.system.effects.filter((x) => x.key !== 'Invisibility');
  const fumbleKind = w.id === 'unarmed' ? 'unarmed' : RANGED.includes(w.category) ? 'ranged' : 'melee';
  return commitActor(actor, changes, itemChanges, () =>
    chat(
      actor,
      `${w.name} → ${target.name}`,
      checkHTML(result) +
        `<p>${e(reasons.join('; '))}</p>` +
        (result.fumble ? `<p><strong>Fumble:</strong> ${e(fumbleText(fumbleKind, result.fumble))}</p>` : '') +
        defenseButtons(target),
      { rolls: result.rolls, flags: packet }
    )
  );
}

export async function defend(message, quick = {}) {
  const attackData = message.getFlag(SYSTEM_ID, 'kind') === 'attack' ? message.flags[SYSTEM_ID] : null;
  if (!attackData || attackData.resolved) throw new RuleError('This attack has already been resolved.');
  const actor = owner(await actorFromUuid(attackData.targetUuid));
  const equipment = actor.items.filter(
    (i) =>
      i.system.equipped &&
      ['weapon', 'shield'].includes(i.type) &&
      (i.system.reliability > 0 || (i.system.properties.natural && i.system.maxReliability <= 0))
  );
  const options = {
    dodge: 'Dodge / Escape',
    reposition: 'Reposition (Athletics)',
    blockWeapon: 'Block with weapon',
    blockShield: 'Block with shield',
    blockArm: 'Block with arm',
    parry: 'Parry',
    passive: 'Passive DC (stunned / inanimate target)',
  };
  const expectedTurn = turnIdentity();
  const quickFields = quick.defense
    ? `<p>${e(titleCase(quick.defense))}${quick.weapon ? ': ' + e(actor.items.get(quick.weapon)?.name) : ''}</p><input type="hidden" name="defense" value="${e(quick.defense)}"><input type="hidden" name="weapon" value="${e(quick.weapon ?? '')}">` +
      input('modifier', 'Other modifier', { value: 0 }) +
      input('gang', 'Assailants in melee reach', { value: 1, min: 1 }) +
      input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value }) +
      woundArmInput(actor) +
      manualCheckInput()
    : null;
  const values = await prompt(
    `${actor.name}: defense`,
    quickFields ??
      input('defense', 'Defense', {
        value:
          quick.defense ??
          (attackData.action === 'feint'
            ? 'awareness'
            : attackData.action === 'escape'
              ? 'grapple'
              : has(actor, 'stunned') || has(actor, 'unconscious')
                ? 'passive'
                : 'dodge'),
        options,
      }) +
        input('weapon', 'Weapon / shield (None = unarmed parry)', {
          value: quick.weapon ?? '',
          options: { '': 'None', ...Object.fromEntries(equipment.map((i) => [i.id, i.name])) },
        }) +
        input('arm', 'Blocking arm', {
          options: Object.fromEntries(
            hitLocations(actorSnapshot(actor))
              .filter((l) => /arm|limb/i.test(l.id))
              .map((l) => [l.id, l.label])
          ),
        }) +
        input('modifier', 'Situational defense modifier', { value: 0 }) +
        input('gang', 'Assailants within melee reach', { value: 1, min: 1 }) +
        input('dc', 'Passive DC', {
          value:
            has(actor, 'stunned') || has(actor, 'unconscious')
              ? 10
              : attackData.range
                ? rangeDifficulty(attackData.range, actor.system.size)
                : 10,
          min: 0,
        }) +
        input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value }) +
        woundArmInput(actor) +
        manualCheckInput(),
    { validate: validateManualCheck }
  );
  if (!values) return;
  return runCommand(
    'defend',
    { messageUuid: message.uuid, values, expectedTurn },
    { label: `${actor.name}: defense` }
  );
}
async function executeDefense(payload, context) {
  const message = await foundry.utils.fromUuid(payload.messageUuid);
  const attackData = message?.flags[SYSTEM_ID];
  if (!message?.author?.isGM) throw new RuleError('This is not a GM-authorized attack result.');
  if (attackData?.kind !== 'attack' || attackData.resolved || attackData.defenseRef)
    throw new RuleError('This attack already has a defense. Use its existing result.');
  const actor = await authorizedActor(attackData.targetUuid, context.user);
  const values = payload.values;
  const defense = values.defense,
    passive = defense === 'passive';
  validateManualCheck(values);
  if (
    !['dodge', 'reposition', 'blockWeapon', 'blockShield', 'blockArm', 'parry', 'passive'].includes(defense)
  )
    throw new RuleError('Invalid defense.');
  if (payload.expectedTurn !== turnIdentity()) throw new RuleError('The turn changed; reopen the defense.');
  for (const key of ['modifier', 'luck', 'gang', 'dc'])
    if (!Number.isFinite(Number(values[key] ?? 0))) throw new RuleError('Invalid defense modifier.');
  if (!passive && (has(actor, 'stunned') || has(actor, 'unconscious')))
    throw new RuleError('A stunned actor is defended at DC 10.');
  const w = actor.items.get(values.weapon);
  const armed = ['blockWeapon', 'blockShield'].includes(defense) || (defense === 'parry' && !!values.weapon);
  if (
    armed &&
    (!w?.system.equipped ||
      (!w.system.properties.natural && !w.system.carried) ||
      w.system.quantity < 1 ||
      w.system.jammed ||
      (w.system.reliability <= 0 && (!w.system.properties.natural || w.system.maxReliability > 0)))
  )
    throw new RuleError('Select an equipped, usable weapon or shield.');
  if (armed) validateWeaponGrip(actorSnapshot(actor), itemSnapshot(w), actorSnapshot(actor).items);
  if (defense === 'blockWeapon' && w?.system.properties.natural && w.system.maxReliability <= 0)
    throw new RuleError(
      'Core does not print natural weapon Reliability. The GM must set current and maximum REL before blocking with it (Journal p.12). Parry remains available.'
    );
  if (defense === 'blockShield' && w?.type !== 'shield') throw new RuleError('Select a shield.');
  if (defense === 'blockWeapon' && w?.type !== 'weapon') throw new RuleError('Select a weapon.');
  if (defense === 'blockArm' && RANGED.includes(attackData.weapon.category))
    throw new RuleError('Only a shield can block ranged attacks.');
  if (
    defense === 'parry' &&
    attackData.weapon.properties?.cannotParry &&
    crushingForce((await actorFromUuid(attackData.actorUuid)).system)
  )
    throw new RuleError('Crushing Force cannot be parried.');
  if (attackData.action === 'feint' && defense !== 'awareness')
    throw new RuleError('A feint is opposed by Awareness.');
  if (attackData.action === 'escape' && defense !== 'grapple')
    throw new RuleError('Escape is opposed by Brawling.');
  if (
    ['grapple', 'pin', 'choke', 'throw', 'takeWeapon'].includes(attackData.action) &&
    !['dodge', 'passive'].includes(defense)
  )
    throw new RuleError('Use Dodge / Escape against wrestling.');
  const plan =
    passive || ['awareness', 'grapple'].includes(defense)
      ? { changes: {}, modifier: 0 }
      : actionPlan(actor, { defense: true });
  let modifier =
    Number(values.modifier) -
    Math.max(0, Number(values.gang) - 1) +
    defenseModifier(defense, attackData.weapon.category);
  if (defense === 'parry' && w?.system.properties.parrying) modifier += 3;
  const skill =
    defense === 'shift'
      ? 'spellCasting'
      : defense === 'awareness'
        ? 'awareness'
        : defense === 'grapple' || defense === 'blockArm' || (defense === 'parry' && !armed)
          ? 'brawling'
          : defense === 'reposition'
            ? 'athletics'
            : defense === 'dodge'
              ? actor.system.environment.underwater &&
                !actor.system.traits.amphibious &&
                !actor.system.effects.some((e) => e.key === 'Swimming')
                ? 'athletics'
                : 'dodge'
              : w?.type === 'shield'
                ? 'melee'
                : w?.system.skill;
  modifier += combatModifier(actor, { defense: true, melee: armed }).modifier;
  if (attackData.invisible) modifier -= 3;
  if (actor.system.effects.some((x) => x.key === 'Hypnosis' && x.sourceUuid === attackData.actorUuid))
    modifier -= 4;
  if (actor.system.environment.swamp && ['dodge', 'athletics'].includes(skill)) modifier -= 2;
  if (armed)
    modifier += validateWeaponGrip(
      actorSnapshot(actor),
      itemSnapshot(w),
      actorSnapshot(actor).items
    ).modifier;
  const luck = Number(values.luck);
  if (!Number.isInteger(luck) || luck < 0 || luck > actor.system.luck.value)
    throw new RuleError('Invalid Luck expenditure.');
  if (passive && luck) throw new RuleError('Luck cannot change a passive DC.');
  if (passive && !context.user.isGM && !has(actor, 'stunned') && !has(actor, 'unconscious'))
    throw new RuleError('Only the GM chooses an unaware or inanimate target DC.');
  const dc = has(actor, 'stunned') || has(actor, 'unconscious') ? 10 : Number(values.dc);
  const usesArms = armed || ['blockArm', 'parry', 'grapple'].includes(defense);
  const injuryArm = usesArms
    ? resolveWoundArm(
        actor.system,
        [...actor.items],
        defense === 'blockArm' ? values.arm : values.woundArm,
        armed && (w.system.handsUsed || w.system.hands) === 2
          ? 'both'
          : armed && w.system.properties?.natural
            ? 'optional'
            : 'one'
      )
    : '';
  const result = passive
    ? { total: dc, rolls: [], base: dc, dice: [], fumble: 0, source: 'passive' }
    : await check(
        actor.skillBase(skill, { modifier: modifier + luck, arm: injuryArm, sight: skill === 'awareness' })
          .total,
        {
          manualDice: values.manualDice,
        }
      );
  const attackRef = message.uuid;
  const defenseId = foundry.utils.randomID();
  // Reserve this attack before spending anything. A second open dialog cannot roll again.
  await message.update({ [`flags.${SYSTEM_ID}.defenseRef`]: `ChatMessage.${defenseId}` });
  let resultMessage;
  try {
    resultMessage = await commitActor(
      actor,
      { ...plan.changes, 'system.luck.value': actor.system.luck.value - luck },
      [],
      () =>
        chat(
          actor,
          `Defense against ${attackData.weapon.name}`,
          checkHTML(result) +
            `<p>${e(titleCase(defense))}</p>` +
            (defense === 'reposition'
              ? `<p>On success you may move ${actor.system.environment.underwater ? actor.system.derived.leap / 2 : actor.system.derived.stats.spd / 2} m to an unblocked space.</p>`
              : '') +
            (result.fumble
              ? `<p>${e(fumbleText(armed ? 'armedDefense' : 'unarmed', result.fumble))}</p>`
              : '') +
            `<button type="button" data-witcher-action="resolve">Resolve (GM)</button>`,
          {
            id: defenseId,
            rolls: result.rolls,
            flags: {
              kind: 'defense',
              authorId: context.user.id,
              attackRef,
              actorUuid: actor.uuid,
              defense,
              weaponId: armed ? w.id : '',
              arm: values.arm,
              check: snapshotRoll(result),
            },
          }
        )
    );
  } catch (error) {
    await message.update({ [`flags.${SYSTEM_ID}.defenseRef`]: '' });
    throw error;
  }
  if (attackData.check.fumble <= 5 && result.fumble <= 5) {
    try {
      await resolveDefense(resultMessage, true);
    } catch (error) {
      errorNotice(error);
    } // The persisted roll remains available to the GM.
  }
  return resultMessage;
}

export async function resolveDefense(message, internal = false) {
  if (!internal) return runCommand('resolveDefense', { messageUuid: message.uuid });
  return (async () => {
    if (!message?.author?.isGM) throw new RuleError('This is not a GM-authorized defense result.');
    const defense = message.flags[SYSTEM_ID];
    if (defense?.kind !== 'defense') throw new RuleError('Not a defense result.');
    const attackMessage = await foundry.utils.fromUuid(defense.attackRef);
    const a = attackMessage?.flags[SYSTEM_ID];
    if (!attackMessage?.author?.isGM) throw new RuleError('This is not a GM-authorized attack result.');
    if (!a || a.resolved) throw new RuleError('This attack has already been resolved.');
    if ((a.check.fumble > 5 && !a.fumbleResolved) || (defense.check.fumble > 5 && !defense.fumbleResolved))
      throw new RuleError('Apply the pending fumble consequences before resolving the hit.');
    const attacker = await actorFromUuid(a.actorUuid),
      target = await actorFromUuid(a.targetUuid);
    if (!attacker || !target || target.uuid !== defense.actorUuid)
      throw new RuleError('The actors no longer match this attack.');
    if (
      !attacker.testUserPermission(game.users.get(a.authorId) ?? attackMessage.author, 'OWNER') ||
      !target.testUserPermission(game.users.get(defense.authorId) ?? message.author, 'OWNER')
    )
      throw new RuleError('The roll author does not own the corresponding actor.');
    const hit = beats(a.check.total, defense.check.total);
    if (!hit && defense.defense !== 'blockArm') {
      const w = target.items.get(defense.weaponId);
      const receipt = `defense:${attackMessage.id}`;
      if (!target.system.combat.applied.includes(receipt)) {
        const updates =
          ['blockWeapon', 'blockShield'].includes(defense.defense) && w
            ? [
                {
                  _id: w.id,
                  'system.reliability': Math.max(
                    0,
                    w.system.reliability -
                      (crushingForce(attacker.system) ? a.weapon.properties?.wearMultiplier || 1 : 1)
                  ),
                },
              ]
            : [];
        await commitActor(
          target,
          { 'system.combat.applied': [...target.system.combat.applied, receipt] },
          updates
        );
      }
      if (defense.defense === 'parry') await attacker.setCondition('staggered');
      if (
        defense.defense === 'parry' &&
        a.weapon.properties?.severableTongue &&
        w?.system.damageTypes.some((t) => ['slashing', 'piercing'].includes(t))
      ) {
        const tongueReceipt = `tongue:${attackMessage.id}`;
        const tongue = attacker.items.get(a.weapon.id);
        if (!attacker.system.combat.applied.includes(tongueReceipt))
          await commitActor(
            attacker,
            {
              'system.hp.value': attacker.system.hp.value - 5,
              'system.combat.applied': [...attacker.system.combat.applied, tongueReceipt],
            },
            tongue ? [{ _id: tongue.id, 'system.equipped': false, 'system.jammed': true }] : []
          );
      }
      if (defense.defense === 'shift')
        await target.update({
          'system.effects': [
            ...target.system.effects.filter((e) => e.key !== 'Shift'),
            { id: foundry.utils.randomID(), key: 'Shift', untilTurn: true },
          ],
        });
      await grantSchoolReactions(
        target,
        schoolReactions(actorSnapshot(target), {
          trigger: 'defense',
          weapon: w ? itemSnapshot(w) : null,
          defense: defense.defense,
          attackTotal: a.check.total,
          defenseTotal: defense.check.total,
        }),
        attackMessage.uuid,
        attacker.uuid,
        { sourceTokenUuid: a.targetTokenUuid, opponentTokenUuid: a.sourceTokenUuid }
      );
      await attackMessage.update({ [`flags.${SYSTEM_ID}.resolved`]: true });
      await chat(
        target,
        'Attack defended',
        `<p>${a.check.total} ≤ ${defense.check.total}. ${e(target.name)} avoids the hit.</p>`
      );
      return;
    }
    if (NO_DAMAGE.includes(a.action)) {
      await resolveSpecial(attacker, target, a, defense);
      await attackMessage.update({ [`flags.${SYSTEM_ID}.resolved`]: true });
      return;
    }
    // A completed card may exist if the final attack-message write failed.
    const existing = game.messages.find(
      (m) => m.flags[SYSTEM_ID]?.kind === 'damage' && m.flags[SYSTEM_ID].attackRef === attackMessage.uuid
    );
    if (existing) {
      await attackMessage.update({
        [`flags.${SYSTEM_ID}.resolved`]: true,
        [`flags.${SYSTEM_ID}.damageRef`]: existing.uuid,
      });
      return existing;
    }
    const damage = await prepareDamage(attacker, target, a, { ...defense, blockSucceeded: !hit });
    const result = await chat(
      attacker,
      `${a.weapon.name}: damage to ${target.name}`,
      damageHTML(damage) + `<button type="button" data-witcher-action="apply">Apply damage (GM)</button>`,
      {
        rolls: damage.rolls,
        flags: {
          kind: 'damage',
          attackRef: attackMessage.uuid,
          actorUuid: attacker.uuid,
          targetUuid: target.uuid,
          request: damage.request,
          wound: damage.wound,
          schoolAdjustment: damage.schoolAdjustment,
          reactions: damage.reactions,
          schoolOnHit: a.schoolOnHit,
          sourceTokenUuid: a.sourceTokenUuid,
          targetTokenUuid: a.targetTokenUuid,
          conditions: damage.conditions,
          effects: damage.effects,
          stun: damage.stun,
          summary: damage.results,
          state: damage.state,
          applied: false,
        },
      }
    );
    await attackMessage.update({
      [`flags.${SYSTEM_ID}.resolved`]: true,
      [`flags.${SYSTEM_ID}.damageRef`]: result.uuid,
    });
    return result;
  })();
}

async function resolveSpecial(attacker, target, a, defense) {
  const rolls = [];
  let text = '';
  if (a.action === 'trip') {
    await target.setCondition('prone');
    text = 'Target is prone.';
  }
  if (a.action === 'grapple') {
    await target.update({
      'system.combat.grappledBy': attacker.uuid,
      'system.conditions': [...new Set([...target.system.conditions, 'grappled'])],
    });
    await attacker.update({ 'system.combat.grappling': target.uuid });
    text = 'Target is grappled: physical actions −2; cannot move away.';
  }
  if (a.action === 'pin') {
    await target.setCondition('pinned');
    text = 'Target is pinned until a successful escape.';
  }
  if (a.action === 'choke') {
    await target.setCondition('suffocating');
    text = 'Target is suffocating until a successful escape.';
  }
  if (a.action === 'escape') {
    await attacker.update({
      'system.combat.grappledBy': '',
      'system.conditions': attacker.system.conditions.filter(
        (c) => !['grappled', 'pinned', 'suffocating'].includes(c)
      ),
    });
    await target.update({ 'system.combat.grappling': '' });
    text = 'The grapple is broken.';
  }
  if (a.action === 'feint') {
    await attacker.update({
      'system.combat.remaining': 1,
      'system.combat.extraPenalty': 3,
      'system.combat.weaponId': a.weapon.id,
      'system.combat.style': 'fast',
    });
    text = 'The second fast strike gains +3.';
  }
  if (['disarm', 'takeWeapon'].includes(a.action)) {
    const held = target.items.filter((i) => i.system.equipped && ['weapon', 'shield'].includes(i.type));
    if (!held.length) throw new RuleError('The defender is not holding a weapon.');
    const choice =
      held.length === 1
        ? { weapon: held[0].id }
        : await prompt(
            'Disarm',
            input('weapon', 'Target weapon', {
              options: Object.fromEntries(held.map((i) => [i.id, i.name])),
            }),
            { button: 'Disarm' }
          );
    if (!choice) throw new RuleError('Disarm resolution cancelled. The attack is still pending.');
    const weapon = target.items.get(choice.weapon);
    if (a.action === 'takeWeapon') {
      const used = attacker.items
        .filter((i) => i.system.equipped && ['weapon', 'shield'].includes(i.type))
        .reduce((n, i) => n + i.system.hands, 0);
      if (used >= 2) throw new RuleError('Taking a weapon requires a free hand.');
      const data = weapon.toObject();
      delete data._id;
      data.system.equipped = true;
      const [created] = await attacker.createEmbeddedDocuments('Item', [data]);
      try {
        await weapon.delete();
      } catch (error) {
        await created.delete();
        throw error;
      }
      text = `${attacker.name} takes ${weapon.name}.`;
    } else {
      const distance = await dice('1d6'),
        direction = await dice('1d10');
      rolls.push(distance, direction);
      await weapon.update({ 'system.equipped': false, 'system.carried': false });
      text = `${weapon.name} falls ${distance.total / (a.weapon.id === 'unarmed' ? 2 : 1)} m away; scatter roll ${direction.total} (p.154).`;
    }
  }
  await chat(attacker, titleCase(a.action), `<p>${e(text)}</p>`, { rolls });
}

export async function prepareDamage(attacker, target, a, defense = {}) {
  const state = actorSnapshot(target),
    table = hitLocations(state),
    rolls = [];
  const w = a.weapon,
    ammo = a.ammunition;
  const properties = {
    ...w.properties,
    ...Object.fromEntries(
      Object.entries(ammo?.properties ?? {}).filter(([, v]) => v !== false && v !== 0 && v !== '')
    ),
  };
  let wound = null,
    bonus = 0,
    location;
  if (!crushingForce(attacker.system)) properties.wearMultiplier = 1;
  const zeroDamage = ['0', '0d6'].includes(w.damage);
  const immune = immuneTo(state, a.type);
  const rolledSeverity =
    !immune && !zeroDamage && a.check && defense.check
      ? criticalSeverity(a.check.total - defense.check.total)
      : null;
  const severity = adjustSchoolCritical(actorSnapshot(attacker), w, rolledSeverity);
  if (severity && !NO_DAMAGE.includes(a.action) && !properties.allLocations) {
    const cr = await dice('2d6'),
      greater = await dice('1d6'),
      side = await dice('1d6');
    rolls.push(cr, greater, side);
    const result = criticalWound(severity.level, table, {
      roll: cr.total,
      aimed: a.aimed?.replace(/:weak$/, ''),
      greater: greater.total,
      side: side.total,
      balanced: properties.balanced ? (a.aimed ? 1 : properties.balancedBonus || 2) : 0,
      organless: target.system.organless,
    });
    wound = result.wound;
    bonus = result.bonus;
    location = result.location;
    if (wound?.stunEveryFormula) {
      const r = await dice(wound.stunEveryFormula);
      rolls.push(r);
      wound.stunEvery = r.total;
    }
    if (wound?.extraRoll) {
      const r = await dice(wound.extraRoll);
      rolls.push(r);
      wound.extraResult = r.total;
      wound.notes = `Teeth lost: ${r.total}`;
    }
  } else if (a.aimed) location = locate(table, a.aimed);
  else {
    const r = await dice('1d10');
    rolls.push(r);
    location = locate(table, r.total);
  }
  if (['pushKick', 'throw'].includes(a.action)) location = locate(table, 'torso');
  if (defense.defense === 'blockArm' && defense.blockSucceeded) location = locate(table, defense.arm);
  if (a.aimed?.endsWith(':weak') && location.id === a.aimed.slice(0, -5)) location = locate(table, a.aimed);
  const chosen = properties.allLocations ? table : [location];
  const requests = [],
    results = [];
  const conditions = [];
  if (a.action === 'throw') conditions.push('prone');
  if (!immune && a.schoolOnHit?.conditions) conditions.push(...a.schoolOnHit.conditions);
  for (const loc of chosen) {
    const roll = await dice(
      a.damageFormula ??
        weaponDamageFormula(w, {
          punch: attacker.system.derived.punch,
          body: attacker.system.derived.stats.body,
        }) ??
        '0'
    );
    rolls.push(roll);
    let raw = Math.max(0, roll.total + weaponDamageBonus(w, a.meleeBonus));
    if (!w.properties?.environmental && !zeroDamage) raw += Number(attacker.system.derived.mods.damage ?? 0);
    const oil = w.oil;
    if (oil?.expires > game.time.worldTime) {
      const categories = {
        'Beast Oil': 'beast',
        'Cursed Oil': 'cursed',
        'Draconid Oil': 'draconid',
        'Elementa Oil': 'elementa',
        'Hanged Man’s Venom': 'humanoid',
        'Hybrid Oil': 'hybrid',
        'Insectoid Oil': 'insectoid',
        'Necrophage Oil': 'necrophage',
        'Ogroid Oil': 'ogroid',
        'Relict Oil': 'relict',
        'Specter Oil': 'specter',
        'Vampire Oil': 'vampire',
      };
      const category = target.type === 'monster' ? target.system.category : 'humanoid';
      if (categories[oil.name] === category) raw += 5;
    }
    if (a.underwater && ['bow', 'crossbow'].includes(w.category)) raw /= 2;
    let silver = 0;
    if (properties.silverDamage) {
      const r = await dice(properties.silverDamage);
      rolls.push(r);
      silver = r.total;
    }
    if (properties.ablating) {
      const r = await dice('1d6');
      rolls.push(r);
      properties.ablation = Math.floor(r.total / 2);
    }
    if (properties.contactAblation) {
      const r = await dice('1d6');
      rolls.push(r);
      properties.fixedAblation = Math.floor(r.total / 2);
    }
    const request = {
      raw,
      silver,
      type: a.type,
      properties: { ...properties },
      multiplier: a.multiplier ?? 1,
      nonlethal: !!a.nonlethal || a.action === 'pommel',
      cover: a.cover ?? 0,
      criticalBonus: chosen.length === 1 ? bonus : 0,
      location: loc.id + (loc.weakSpot ? ':weak' : ''),
    };
    if (loc.id === 'head' && target.system.derived.mods.headMultiplier)
      loc.multiplier = target.system.derived.mods.headMultiplier;
    const result = resolveDamage(request, state, loc, state.items);
    requests.push(request);
    results.push(result);
  }
  if (results.some((r) => r.penetrated) || (zeroDamage && !isIncorporeal(state))) {
    for (const [property, condition] of [
      ['bleeding', 'bleeding'],
      ['poison', 'poison'],
      ['fire', 'fire'],
      ['freeze', 'frozen'],
      ['stagger', 'staggered'],
    ])
      if (properties[property] && !immuneTo(state, condition)) {
        const r = await dice('1d100');
        rolls.push(r);
        if (r.total <= properties[property]) conditions.push(condition);
      }
  }
  const effects = [];
  if (!isIncorporeal(state) && properties.webbing) {
    conditions.push('grappled');
    effects.push({ id: foundry.utils.randomID(), key: 'Webbing', sourceUuid: attacker.uuid, hp: 10, dc: 16 });
  }
  if (properties.blindRounds) {
    const roll = await dice(properties.blindRounds);
    rolls.push(roll);
    conditions.push('blinded');
    effects.push({
      id: foundry.utils.randomID(),
      key: 'Dust Devil',
      expires: game.time.worldTime + roll.total * 3,
      removeCondition: 'blinded',
    });
  }
  return {
    request: requests,
    results,
    rolls,
    wound,
    schoolAdjustment: severity?.schoolAdjustment ?? null,
    reactions: schoolReactions(actorSnapshot(attacker), {
      trigger: 'critical',
      weapon: w,
      criticalCaused: !!wound,
    }),
    conditions,
    effects,
    stun: severity ? 0 : properties.stunWeapon ? properties.stun : a.action === 'throw' ? -1 : null,
    state: damageState(target),
  };
}

export function damageState(actor) {
  return JSON.stringify({
    hp: actor.system.hp.value,
    sta: actor.system.sta.value,
    conditions: actor.system.conditions,
    locations: actor.system.locations,
    items: actor.items
      .filter((i) => ['armor', 'wound'].includes(i.type))
      .map((i) => [i.id, i.system.toObject()]),
    race: actor.system.race,
    resistances: actor.system.resistances,
    naturalResistances: actor.system.naturalResistances,
    immunities: actor.system.immunities,
    vulnerabilities: actor.system.vulnerabilities,
    silverVulnerable: actor.system.silverVulnerable,
    meteoriteVulnerable: actor.system.meteoriteVulnerable,
    traits: actor.system.traits,
    effects: actor.system.effects,
  });
}
export function damageHTML(damage) {
  return `<table><thead><tr><th>Location</th><th>Rolled</th><th>Cover</th><th>SP</th><th>After armor</th><th>× location</th><th>Critical</th><th>Damage</th></tr></thead><tbody>${damage.results.map((r) => `<tr><td>${e(r.location.label)}</td><td>${r.rolled}</td><td>${r.cover}</td><td>${r.sp}</td><td>${r.resisted}</td><td>${r.location.multiplier}</td><td>${r.criticalBonus}</td><td><strong>${r.damage} ${r.nonlethal ? 'STA' : 'HP'}</strong></td></tr>`).join('')}</tbody></table>${damage.wound ? `<p>Critical wound: <strong>${e(damage.wound.name)}</strong></p>` : ''}${damage.schoolAdjustment ? `<p>${e(damage.schoolAdjustment.from)} → ${e(damage.schoolAdjustment.to)}: Critical Decimation. ${e(damage.schoolAdjustment.note)}</p>` : ''}${damage.conditions?.length ? `<p>${e(damage.conditions.join(', '))}</p>` : ''}`;
}

export async function applyDamage(message, internal = false) {
  if (!internal) return runCommand('applyDamage', { messageUuid: message.uuid });
  return (async () => {
    if (!message?.author?.isGM) throw new RuleError('This is not a GM-authorized damage result.');
    const data = message.flags[SYSTEM_ID];
    if (data?.kind !== 'damage') throw new RuleError('Not a damage result.');
    const target = await actorFromUuid(data.targetUuid);
    if (!target) throw new RuleError('Target no longer exists.');
    const receipt = `damage:${data.attackRef || message.uuid}`;
    if (data.applied) throw new RuleError('This damage has already been applied.');
    if (target.system.combat.applied.includes(receipt)) return finalizeDamage(message, target, data);
    if (damageState(target) !== data.state) {
      const state = actorSnapshot(target);
      const results = data.request.map((r) =>
        resolveDamage(r, state, locate(hitLocations(state), r.location), state.items)
      );
      const canAffect = data.request.some((r) => !immuneTo(state, r.type));
      const conditions = (data.conditions ?? []).filter((c) => canAffect && !immuneTo(state, c));
      const wound = canAffect ? data.wound : null;
      const stun = canAffect ? data.stun : null;
      const effects = canAffect ? data.effects : [];
      await message.update({
        [`flags.${SYSTEM_ID}.conditions`]: conditions,
        [`flags.${SYSTEM_ID}.wound`]: wound,
        [`flags.${SYSTEM_ID}.stun`]: stun,
        [`flags.${SYSTEM_ID}.effects`]: effects,
        [`flags.${SYSTEM_ID}.state`]: damageState(target),
        [`flags.${SYSTEM_ID}.summary`]: results,
        content: `<article class="witcher-chat"><h3>Damage recalculated: ${e(target.name)}</h3>${damageHTML({ ...data, results, wound, conditions })}<p>Armor or resources changed. Review the updated calculation.</p><button type="button" data-witcher-action="apply">Apply damage (GM)</button></article>`,
      });
      return;
    }
    const changes = planDamageChanges(target, data.summary, data.conditions ?? []);
    if (data.effects?.length)
      changes.actor['system.effects'] = [
        ...(changes.actor['system.effects'] ?? target.system.effects),
        ...data.effects,
      ];
    changes.actor['system.combat.applied'] = [...target.system.combat.applied, receipt];
    const created = [];
    try {
      if (data.wound) {
        created.push(...(await target.createEmbeddedDocuments('Item', [woundItemData(data.wound)])));
        changes.actor['system.sta.value'] = Math.min(
          changes.actor['system.sta.value'],
          staminaCapChanges(target)['system.sta.value']
        );
        if (data.wound.fatal) changes.actor['system.conditions'].push('dead');
        if (data.wound.deathSave)
          changes.actor['system.pendingDeathSaves'] =
            (changes.actor['system.pendingDeathSaves'] ?? target.system.pendingDeathSaves) + 1;
      }
      await commitActor(target, changes.actor, changes.items);
    } catch (error) {
      if (created.length)
        await target.deleteEmbeddedDocuments(
          'Item',
          created.map((i) => i.id)
        );
      throw error;
    }
    return finalizeDamage(message, target, data);
  })();
}

async function finalizeDamage(message, target, data) {
  if (data.wound && data.reactions?.length) {
    const attacker = await actorFromUuid(data.actorUuid);
    if (attacker)
      await grantSchoolReactions(attacker, data.reactions, data.attackRef, target.uuid, {
        sourceTokenUuid: data.sourceTokenUuid,
        opponentTokenUuid: data.targetTokenUuid,
      });
  }
  if (data.schoolOnHit?.knockbackMeters && data.summary.some((r) => !r.immune))
    await shieldKnockback(message, data);
  if (data.stun !== null && data.stun !== undefined && !has(target, 'dead'))
    await save(target, 'stun', { modifier: data.stun, receipt: `stun:${data.attackRef || message.uuid}` });
  if (
    target.system.pendingDeathSaves &&
    !has(target, 'dead') &&
    !game.messages.some((m) => m.flags[SYSTEM_ID]?.deathFor === message.uuid)
  )
    await chat(
      target,
      'Death save required',
      `<p>${target.system.pendingDeathSaves} save(s) pending. Choose Luck before rolling.</p><button type="button" data-witcher-action="death">Death save</button>`,
      { flags: { actorUuid: target.uuid, deathFor: message.uuid } }
    );
  await message.update({
    [`flags.${SYSTEM_ID}.applied`]: true,
    content: message.content.replace(
      /<button\b[^>]*data-witcher-action="apply"[^>]*>[\s\S]*?<\/button>/g,
      '<p><strong>Damage applied.</strong></p>'
    ),
  });
}
async function shieldKnockback(message, data) {
  const sourceDoc = data.sourceTokenUuid ? await foundry.utils.fromUuid(data.sourceTokenUuid) : null;
  const targetDoc = data.targetTokenUuid ? await foundry.utils.fromUuid(data.targetTokenUuid) : null;
  const source = sourceDoc?.object,
    target = targetDoc?.object;
  if (!source || !target || source.scene.id !== target.scene.id) {
    throw new RuleError(
      'Damage is saved. Display the attack scene and click Apply again to finish shield knockback.'
    );
  }
  const receipt = `knockback:${data.attackRef || message.uuid}`;
  if ((targetDoc.getFlag(SYSTEM_ID, 'movements') ?? []).includes(receipt)) return;
  const dx = target.center.x - source.center.x,
    dy = target.center.y - source.center.y;
  const length = Math.hypot(dx, dy);
  if (!length)
    throw new RuleError(
      'Damage is saved. Separate overlapping tokens before resolving the knockback direction.'
    );
  const distance = (data.schoolOnHit.knockbackMeters * canvas.dimensions.size) / canvas.dimensions.distance;
  const desired = {
    x: target.center.x + (dx / length) * distance,
    y: target.center.y + (dy / length) * distance,
  };
  // Binary search along the ray to stop at blocking walls and the edge of the scene.
  const rect = canvas.dimensions.sceneRect;
  const valid = (point) =>
    point.x - target.w / 2 >= rect.x &&
    point.y - target.h / 2 >= rect.y &&
    point.x + target.w / 2 <= rect.right &&
    point.y + target.h / 2 <= rect.bottom &&
    !target.checkCollision(point, { type: 'move', mode: 'any' });
  let fraction = 1;
  if (!valid(desired)) {
    let low = 0,
      high = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2;
      if (
        valid({
          x: target.center.x + (desired.x - target.center.x) * mid,
          y: target.center.y + (desired.y - target.center.y) * mid,
        })
      )
        low = mid;
      else high = mid;
    }
    fraction = low;
  }
  await targetDoc.update({
    x: Math.round(target.document.x + (desired.x - target.center.x) * fraction),
    y: Math.round(target.document.y + (desired.y - target.center.y) * fraction),
    [`flags.${SYSTEM_ID}.movements`]: [...(targetDoc.getFlag(SYSTEM_ID, 'movements') ?? []), receipt],
  });
}

export function planDamageChanges(actor, results, addConditions = []) {
  const conditions = new Set([
    ...actor.system.conditions,
    ...addConditions.filter((c) => !immuneTo(actor.system, c)),
  ]);
  if (results.some((r) => r.damage > 0)) conditions.delete('stunned');
  let hp = actor.system.hp.value,
    sta = actor.system.sta.value;
  const locations = foundry.utils.deepClone(actor.system.locations),
    items = new Map();
  for (const result of results) {
    if (result.nonlethal) {
      if (!actor.system.traits.infiniteStamina) sta -= result.damage;
    } else hp -= result.damage;
    for (const change of result.armorChanges) {
      const update = items.get(change.id) ?? { _id: change.id };
      update[`system.sp.${change.location}`] = change.after;
      items.set(change.id, update);
    }
    const loc = locations.find((l) => l.id === result.naturalChange.location);
    if (loc) loc[result.naturalChange.field ?? 'sp'] = result.naturalChange.after;
  }
  const changes = { 'system.hp.value': hp, 'system.sta.value': sta, 'system.locations': locations };
  if (results.some((r) => r.damage > 0)) changes['system.combat.hitThisRound'] = true;
  const effects = foundry.utils.deepClone(actor.system.effects);
  const fullMoon = effects.find((x) => x.temporaryHp > 0);
  if (fullMoon) {
    fullMoon.temporaryHp = Math.max(
      0,
      fullMoon.temporaryHp - results.filter((r) => !r.nonlethal).reduce((n, r) => n + r.damage, 0)
    );
    changes['system.effects'] = effects;
  }
  if (sta <= 0 && !actor.system.traits.infiniteStamina) {
    conditions.add('stunned');
    conditions.add('unconscious');
    changes['system.unconsciousRecovery'] = 0;
  }
  if (hp <= 0 && results.some((r) => !r.nonlethal && r.damage > 0))
    changes['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  if (actor.system.conditions.includes('unconscious')) conditions.add('stunned');
  changes['system.conditions'] = [...conditions];
  return { actor: changes, items: [...items.values()] };
}

async function grantSchoolReactions(actor, descriptors, eventId, opponentUuid, tokens = {}) {
  if (!descriptors?.length) return;
  const receipt = `school:${eventId}`;
  if (actor.system.combat.applied.includes(receipt)) return;
  const reactions = descriptors
    .filter((r) => !r.deferred)
    .map((r) => ({ ...r, id: foundry.utils.randomID(), turn: turnIdentity(), opponentUuid, ...tokens }));
  const content =
    descriptors
      .filter((r) => r.deferred)
      .map(
        (r) =>
          `<p>${e(r.name)} permits a Sign now. Sign automation is deferred; pay its normal STA when resolving it manually.</p>`
      )
      .join('') +
    reactions
      .map(
        (r) =>
          `<p>${e(r.name)}: immediate, one choice, no additional action or STA.</p>` +
          r.choices
            .map(
              (c) =>
                `<button type="button" data-witcher-action="school" data-reaction="${r.id}" data-choice="${c.key}">${e(c.label)}</button>`
            )
            .join('') +
          `<button type="button" data-witcher-action="declineSchool" data-reaction="${r.id}">Decline</button>`
      )
      .join('');
  await commitActor(
    actor,
    {
      'system.combat.reactions': [
        ...actor.system.combat.reactions.filter((r) => r.turn === turnIdentity()),
        ...reactions,
      ],
      'system.combat.applied': [...actor.system.combat.applied, receipt],
    },
    [],
    () => chat(actor, 'School armor reaction', content, { flags: { kind: 'school', actorUuid: actor.uuid } })
  );
}
async function chooseSchoolReaction(message, reactionId, choiceId) {
  const actor = owner(await actorFromUuid(message.flags[SYSTEM_ID].actorUuid));
  const reaction = actor.system.combat.reactions.find((r) => r.id === reactionId);
  const choice = reaction?.choices.find((c) => c.key === choiceId);
  if (!choice || reaction.turn !== turnIdentity())
    throw new RuleError('This immediate reaction is no longer available.');
  const weapons = actor.items.filter(
    (i) =>
      ['weapon', 'shield'].includes(i.type) &&
      i.system.equipped &&
      i.system.quantity > 0 &&
      (choice.weaponRequirement !== 'manticoreShield' ||
        (i.type === 'shield' && i.system.school === 'manticore'))
  );
  const values = await prompt(
    reaction.name,
    input('weapon', 'Held weapon', { options: Object.fromEntries(weapons.map((i) => [i.id, i.name])) }),
    { button: 'Choose attack' }
  );
  if (!values) return;
  const target =
    choice.targetConstraint === 'triggeringAttacker'
      ? await actorFromUuid(reaction.opponentUuid)
      : ([...game.user.targets][0]?.actor ?? (await actorFromUuid(reaction.opponentUuid)));
  return attack(actor, actor.items.get(values.weapon), {
    target,
    sourceTokenUuid: reaction.sourceTokenUuid,
    targetTokenUuid:
      choice.targetConstraint === 'triggeringAttacker' || !game.user.targets.size
        ? reaction.opponentTokenUuid
        : [...game.user.targets][0]?.document.uuid,
    style: 'normal',
    action: choice.action,
    reactionId,
    reactionChoice: choiceId,
  });
}

export function registerCombatChat() {
  registerCommand('declineSchool', async (p, c) => {
    const actor = await authorizedActor(p.actorUuid, c.user);
    return actor.update({
      'system.combat.reactions': actor.system.combat.reactions.filter((r) => r.id !== p.reactionId),
    });
  });
  registerCommand('combatSave', async (p, c) => {
    const actor = await authorizedActor(p.actorUuid, c.user);
    if (p.kind === 'death' && actor.system.pendingDeathSaves < 1)
      throw new RuleError('No death save is pending.');
    return save(actor, p.kind, { luck: Number(p.luck ?? 0) });
  });
  registerCommand('attack', executeAttack);
  registerCommand('defend', executeDefense);
  registerCommand('resolveDefense', async (p, c) => {
    if (!c.user.isGM) throw new RuleError('The GM resolves pending attack consequences.');
    return resolveDefense(await foundry.utils.fromUuid(p.messageUuid), true);
  });
  registerCommand('applyDamage', async (p, c) => {
    if (!c.user.isGM) throw new RuleError('The GM applies damage.');
    return applyDamage(await foundry.utils.fromUuid(p.messageUuid), true);
  });
  Hooks.on('renderChatMessageHTML', (message, html) => {
    html.querySelectorAll('[data-witcher-action]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        button.disabled = true;
        try {
          const action = button.dataset.witcherAction;
          if (action === 'school')
            await chooseSchoolReaction(message, button.dataset.reaction, button.dataset.choice);
          if (action === 'declineSchool')
            await runCommand('declineSchool', {
              actorUuid: message.flags[SYSTEM_ID].actorUuid,
              reactionId: button.dataset.reaction,
            });
          if (action === 'defend')
            await defend(message, { defense: button.dataset.defense, weapon: button.dataset.weapon });
          if (action === 'resolve') await resolveDefense(message);
          if (action === 'apply') await applyDamage(message);
          if (action === 'death') {
            const actor = owner(await actorFromUuid(message.flags[SYSTEM_ID].actorUuid));
            const values = await prompt(
              'Death save',
              input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value })
            );
            if (values)
              await runCommand('combatSave', {
                actorUuid: actor.uuid,
                kind: 'death',
                luck: Number(values.luck),
              });
          }
        } catch (error) {
          errorNotice(error);
        } finally {
          button.disabled = false;
        }
      })
    );
  });
}
