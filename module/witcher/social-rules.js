/** Optional Verbal Combat, Core pp.176–177. Unprinted conventions are explicit encounter data. */
import { RuleError } from './rules.js';
import { SKILLS } from './config.js';

const attack = (name, family, skill, die, damageStat, extra = {}) => ({
  name,
  family,
  skill,
  die,
  damageStat,
  ...extra,
});
export const SOCIAL_ATTACKS = Object.freeze({
  seduce: attack('Seduce', 'empathetic', 'seduction', 6, 'emp', { cumulative: 2 }),
  persuade: attack('Persuade', 'empathetic', 'persuasion', 6, 'emp', { divisor: 2 }),
  appeal: attack('Appeal', 'empathetic', 'leadership', 10, 'emp', { cumulative: 1 }),
  befriend: attack('Befriend', 'empathetic', 'charisma', 6, 'emp'),
  deceive: attack('Deceive', 'antagonistic', 'deceit', 6, 'int'),
  ridicule: attack('Ridicule', 'antagonistic', 'socialEtiquette', 6, 'will'),
  intimidate: attack('Intimidate', 'antagonistic', 'intimidation', 10, 'will', { cumulative: 4 }),
});
export const SOCIAL_DEFENSES = Object.freeze({
  ignore: { name: 'Ignore', skill: 'resistCoercion', die: 10, damageStat: 'emp' },
  counter: { name: 'Counter-argue' },
  subject: { name: 'Change the Subject', skill: 'persuasion', die: 6, damageStat: 'int' },
  disengage: { name: 'Disengage', skill: 'resistCoercion', die: 0 },
});
export const SOCIAL_TOOLS = Object.freeze({
  romance: { name: 'Romance', family: 'empathetic', skill: 'charisma' },
  study: { name: 'Study', family: 'empathetic', skill: 'humanPerception' },
  imply: { name: 'Imply', family: 'antagonistic', skills: ['persuasion', 'deceit'] },
  bribe: { name: 'Bribe', family: 'antagonistic', skill: 'gambling' },
});
export const SOCIAL_CONVENTIONS = Object.freeze({
  resolveRounding: ['final', 'average'],
  halfDamage: ['exact', 'floor', 'ceil'],
  tiedDefense: ['blockOnly', 'fullEffect'],
  cumulativeTiming: ['subsequentHits', 'triggeringHit'],
  cumulativeScope: ['source', 'target'],
  multiDamage: ['shared', 'separate'],
  groupResolution: ['simultaneous', 'ordered'],
  disengage: ['participant', 'encounter'],
  timing: ['verbalTurns', 'foundryCombat'],
  repeatedDefenses: ['free', 'stamina'],
  implyUse: ['attempt', 'success'],
  studyExpiry: ['startNextTurn', 'endNextTurn', 'roundEnd'],
  studyScope: ['target', 'all'],
  bribeScope: ['target', 'all'],
  bribeIncrements: ['whole', 'fractional'],
  repeatedBribes: ['replace', 'sum'],
  tortureSeverity: ['replace', 'stack'],
  tortureThreshold: ['below', 'atOrBelow'],
  negativeRecognition: ['signed', 'absolute'],
  faceDownFrequency: ['oncePerOpponent', 'repeat'],
});
export function validateSocialConventions(conventions = {}) {
  for (const [key, allowed] of Object.entries(SOCIAL_CONVENTIONS))
    if (!allowed.includes(conventions[key])) throw new RuleError(`Record the table convention for ${key}.`);
  return structuredClone(conventions);
}
export const socialStat = (actor, key) =>
  Number((actor.system ?? actor).derived?.stats?.[key] ?? (actor.system ?? actor).stats?.[key] ?? 0);
export function initialResolve(actor, rounding) {
  const mean = (socialStat(actor, 'will') + socialStat(actor, 'int')) / 2;
  if (!['final', 'average'].includes(rounding))
    throw new RuleError('Choose the Resolve rounding convention.');
  return Math.max(0, rounding === 'average' ? Math.floor(mean) * 5 : Math.floor(mean * 5));
}
export function socialMove(key, { defense = false, counterAttack = '', skill = '' } = {}) {
  if (defense) {
    if (!SOCIAL_DEFENSES[key]) throw new RuleError('Choose a printed verbal defense.');
    if (key === 'counter') {
      if (!SOCIAL_ATTACKS[counterAttack]) throw new RuleError('Choose the attack used to counter-argue.');
      return { ...SOCIAL_ATTACKS[counterAttack], key: counterAttack, defense: key };
    }
    return { ...SOCIAL_DEFENSES[key], key, defense: key };
  }
  const move = SOCIAL_ATTACKS[key] ?? SOCIAL_TOOLS[key];
  if (!move) throw new RuleError('Choose a printed verbal attack or tool.');
  if (move.skills && !move.skills.includes(skill)) throw new RuleError('Imply uses Persuasion or Deceit.');
  return { ...move, key, skill: move.skills ? skill : move.skill, tool: !!SOCIAL_TOOLS[key] };
}
export function validateToolOpposition(value) {
  if (!value?.reason?.trim())
    throw new RuleError('The GM must record the unprinted tool opposition and its reason.');
  if (value.kind === 'dc' && Number.isFinite(value.dc) && value.dc >= 0)
    return { kind: 'dc', dc: value.dc, reason: value.reason.trim() };
  if (value.kind === 'opposed' && SKILLS[value.skill])
    return { kind: 'opposed', skill: value.skill, reason: value.reason.trim() };
  throw new RuleError('The tool needs a GM-selected DC or an actual opposed skill check.');
}
export function verbalDefenseResult(attackTotal, defenseTotal, convention) {
  const defended = defenseTotal >= attackTotal;
  return { defended, returnEffect: defended && (defenseTotal > attackTotal || convention === 'fullEffect') };
}
export function socialDamage(move, actor, die, rounding = 'exact') {
  if (!move.die) return 0;
  if (!Number.isInteger(die) || die < 1 || die > move.die) throw new RuleError('Invalid verbal damage die.');
  let damage = die / (move.divisor ?? 1);
  if (rounding === 'floor') damage = Math.floor(damage);
  else if (rounding === 'ceil') damage = Math.ceil(damage);
  else if (rounding !== 'exact') throw new RuleError('Choose the verbal damage rounding convention.');
  return Math.max(
    0,
    damage + (Number.isFinite(move.damageValue) ? move.damageValue : socialStat(actor, move.damageStat))
  );
}
const counterKey = (encounter, source, target) =>
  encounter.conventions.cumulativeScope === 'source' ? `${source}>${target}` : target;
export function cumulativeDamage(encounter, source, target, move, { increment = false } = {}) {
  const key = counterKey(encounter, source, target),
    counters = (encounter.counters[key] ??= { seduce: 0, appeal: 0, intimidate: 0 });
  if (increment && ['seduce', 'appeal', 'intimidate'].includes(move.key)) counters[move.key]++;
  return (
    (move.key === 'seduce' ? counters.seduce * 2 : 0) +
    (move.key === 'intimidate' ? counters.intimidate * 4 : 0) +
    (move.family === 'empathetic' ? counters.appeal : 0)
  );
}
export function standingModifier(skill, standing = 'equal', feared = false) {
  if (!['equal', 'tolerated', 'hated'].includes(standing))
    throw new RuleError('Choose Equal, Tolerated or Hated standing.');
  let value = ['seduction', 'charisma', 'persuasion', 'leadership'].includes(skill)
    ? -{ equal: 0, tolerated: 1, hated: 2 }[standing]
    : 0;
  if (feared) value += skill === 'intimidation' ? 1 : skill === 'charisma' ? -1 : 0;
  return value;
}
export function activeSocialRelationships(actor) {
  return (actor.system ?? actor).social?.relationships ?? [];
}
export function socialReputation(
  actor,
  { audienceId = '', monsterSlayer = false, trophyBonus = 0, time = 0 } = {}
) {
  const state = actor.system ?? actor;
  return (
    Number(state.reputation ?? 0) +
    (monsterSlayer ? trophyBonus : 0) +
    (state.social?.reputationEffects ?? [])
      .filter((effect) => effect.audienceId === audienceId && effect.expires > time)
      .reduce((sum, effect) => sum + Number(effect.amount ?? 0), 0)
  );
}
export function socialModifiers(
  encounter,
  source,
  target,
  move,
  { defense = false, time = 0, standing = 'equal', feared = false, standingHandled = false, trophy = {} } = {}
) {
  const sourceUuid = source.uuid,
    targetUuid = target.uuid,
    modifiers = [];
  const add = (label, value) => {
    if (value) modifiers.push({ label, value });
  };
  if (trophy.socialStandingSteps)
    standing = ['hated', 'tolerated', 'equal'][
      Math.min(2, ['hated', 'tolerated', 'equal'].indexOf(standing) + trophy.socialStandingSteps)
    ];
  const wasFeared = feared;
  feared ||= trophy.socialStanding === 'feared';
  add(
    'Social standing',
    standingHandled
      ? standingModifier(move.skill, 'equal', feared)
      : standingModifier(move.skill, standing, feared)
  );
  if (wasFeared && trophy.doubleExistingFearedBonus && move.skill === 'intimidation')
    add('Botchling trophy', 1);
  if (
    (source.system ?? source).race === 'human' &&
    (target.system ?? target).race === 'human' &&
    ['charisma', 'seduction', 'persuasion'].includes(move.skill)
  )
    add('Human Trustworthy', 1);
  const relation = activeSocialRelationships(source).find((row) => row.otherUuid === targetUuid);
  if (relation?.romance === 'active') add('Romance with this opponent', -3);
  if (relation?.romance === 'bitter' && defense && move.incomingFamily === 'empathetic')
    add('Romance ended badly', 3);
  for (const effect of encounter.effects ?? []) {
    if (effect.expiresTurn !== undefined && encounter.turnSerial >= effect.expiresTurn) continue;
    if (
      effect.kind === 'study' &&
      effect.actorUuid === sourceUuid &&
      (!effect.targetUuid || effect.targetUuid === targetUuid)
    )
      add('Study', 2);
    if (effect.kind === 'imply' && defense && effect.actorUuid === sourceUuid) add('Imply', -4);
    if (
      effect.kind === 'bribe' &&
      effect.actorUuid === sourceUuid &&
      move.family === 'empathetic' &&
      (!effect.targetUuid || effect.targetUuid === targetUuid)
    )
      add('Bribe offer', effect.bonus);
    if (
      effect.kind === 'reputation' &&
      effect.actorUuid === sourceUuid &&
      effect.targetUuid === targetUuid &&
      effect.skills.includes(move.skill)
    )
      add('Reputation Face-Down', 3);
  }
  const torture = encounter.torture?.find(
    (row) => row.actorUuid === sourceUuid && row.targetUuid === targetUuid
  );
  if (torture && (move.family === 'empathetic' || move.skill === 'intimidation')) {
    let severity = torture.severe ? 10 : 3;
    if (torture.severe && encounter.conventions.tortureSeverity === 'stack') severity += 3;
    add('Torture & Torment', move.family === 'empathetic' ? -severity : severity);
  }
  return { modifiers, total: modifiers.reduce((sum, row) => sum + row.value, 0), standing, feared };
}
export function relationshipUpdate(actor, otherUuid, update, source) {
  const relationships = structuredClone(activeSocialRelationships(actor));
  let relation = relationships.find((row) => row.otherUuid === otherUuid);
  if (!relation) relationships.push((relation = { otherUuid, friendship: 0, romance: 'none', sources: [] }));
  if (update === 'befriend') relation.friendship = Math.min(3, (relation.friendship ?? 0) + 1);
  else if (update === 'romance') relation.romance = 'active';
  else if (update === 'bitter') relation.romance = 'bitter';
  else if (update === 'endRomance') relation.romance = 'none';
  else throw new RuleError('Unknown relationship change.');
  if (!relation.sources.includes(source)) relation.sources.push(source);
  return relationships;
}
export function studyExpiry(encounter) {
  const count = encounter.clockTurns ?? encounter.order.length;
  if (encounter.conventions.studyExpiry === 'roundEnd')
    return encounter.turnSerial + count - (encounter.clockTurn ?? encounter.turnIndex);
  return encounter.turnSerial + count + (encounter.conventions.studyExpiry === 'endNextTurn' ? 1 : 0);
}
