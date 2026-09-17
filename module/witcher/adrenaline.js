import { SYSTEM_ID } from './config.js';
import { activeAlchemy } from './alchemy-rules.js';
import { RuleError } from './rules.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { commitActor, dice, chat, prompt, input, serial, errorNotice } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import { enhancementBenefits, actorEnhancementBenefits } from './enhancements.js';

const path = `flags.${SYSTEM_ID}.adrenaline`;
export function adrenalineEnabled() {
  return globalThis.game?.settings?.get(SYSTEM_ID, 'adrenaline') === true;
}
export function adrenalineState(actor) {
  const state = actor.flags?.[SYSTEM_ID]?.adrenaline;
  return state?.combatId === game.combat?.id && game.combat?.started
    ? { ...state, dice: Math.min(Number(state.dice) || 0, actor.system.derived.stats.body) }
    : { combatId: game.combat?.started ? game.combat.id : '', dice: 0, receipts: [] };
}
export function adrenalineSpendPlan(actor, count, sta = actor.system.sta.value) {
  const state = adrenalineState(actor),
    amount = Number(count ?? 0);
  if (!Number.isInteger(amount) || amount < 0)
    throw new RuleError('Choose a whole number of adrenaline dice.');
  if (!amount) return {};
  if (!adrenalineEnabled() || !state.combatId)
    throw new RuleError('Adrenaline requires its optional rule and an active combat.');
  if (amount > state.dice) throw new RuleError('Not enough adrenaline dice.');
  const cost = actorEnhancementBenefits(actor.items).placation ? 5 : 10;
  if (amount * cost > sta) throw new RuleError(`Each adrenaline die costs ${cost} STA.`);
  return { [path]: { ...state, dice: state.dice - amount }, 'system.sta.value': sta - amount * cost };
}
export async function gainAdrenaline(actor, receipt, { critical = false, weapon } = {}) {
  if (!critical || !adrenalineEnabled() || !game.combat?.started) return;
  const state = adrenalineState(actor);
  if (state.receipts.includes(receipt)) return;
  const gain =
    1 +
    (activeAlchemy(actor.system, 'maribor-forest') ? 1 : 0) +
    (weapon ? enhancementBenefits(weapon).adrenalineExtra : 0);
  await commitActor(actor, {
    [path]: {
      ...state,
      dice: Math.min(actor.system.derived.stats.body, state.dice + gain),
      receipts: [...state.receipts, receipt],
    },
  });
}
export async function retainAdrenaline(actor, receipt, count) {
  if (!(count > 0) || !adrenalineEnabled() || !game.combat?.started) return;
  const state = adrenalineState(actor);
  if (state.receipts.includes(receipt)) return;
  await commitActor(actor, {
    [path]: {
      ...state,
      dice: Math.min(actor.system.derived.stats.body, state.dice + count),
      receipts: [...state.receipts, receipt],
    },
  });
}
export async function spendAdrenalineHP(actor) {
  const state = adrenalineState(actor);
  const result = await prompt(
    'Adrenaline: temporary HP',
    `<p>${state.dice} dice available. Each costs ${actorEnhancementBenefits(actor.items).placation ? 5 : 10} STA. Bonus HP ends with combat (Core p.175).</p>` +
      input('count', 'Dice to spend', { value: 1, min: 1, max: state.dice }) +
      (actor.system.hp.value < 0
        ? input('emergency', 'Emergency: return to 1 HP with one die (table ruling)', { type: 'checkbox' })
        : ''),
    { button: 'Spend adrenaline' }
  );
  if (!result) return;
  return runCommand('adrenalineHP', {
    actorUuid: actor.uuid,
    count: Number(result.count),
    emergency: !!result.emergency,
  });
}
export async function executeAdrenalineHP({ actorUuid, count, emergency = false }, { user }) {
  const actor = await authorizedActor(actorUuid, user);
  if (actor.system.conditions.includes('dead')) throw new RuleError('Adrenaline does not revive the dead.');
  if (emergency && (actor.system.hp.value >= 0 || count !== 1))
    throw new RuleError('Emergency adrenaline requires negative HP and exactly one die.');
  const changes = adrenalineSpendPlan(actor, count);
  const staminaSpent = actor.system.sta.value - changes['system.sta.value'];
  if (!count) throw new RuleError('Spend at least one adrenaline die.');
  const roll = emergency ? null : await dice(`${count}d6`);
  const retained =
    roll &&
    [...actor.items].some((item) => item.system.equipped && enhancementBenefits(item).adrenalineRetainOne)
      ? (roll.dice ?? [])
          .flatMap((die) => die.results ?? [])
          .filter((result) => result.active !== false && result.result === 1).length
      : 0;
  if (retained) changes[path].dice = Math.min(actor.system.derived.stats.body, changes[path].dice + retained);
  const hp = emergency ? 1 - actor.system.hp.value : roll.total;
  const effects = structuredClone(actor.system.effects);
  let effect = effects.find((entry) => entry.adrenaline?.combatId === game.combat.id);
  if (!effect) {
    effect = {
      id: foundry.utils.randomID(),
      key: 'Adrenaline HP',
      modifiers: { hp: 0 },
      temporaryHp: 0,
      adrenaline: { combatId: game.combat.id },
    };
    effects.push(effect);
  }
  effect.temporaryHp += hp;
  effect.modifiers.hp += hp;
  changes['system.effects'] = effects;
  changes['system.hp.value'] = actor.system.hp.value + hp;
  if (emergency) changes['system.pendingDeathSaves'] = 0;
  return commitActor(actor, changes, [], () =>
    chat(
      actor,
      'Adrenaline',
      `<p>${count} dice spent; ${staminaSpent} STA; +${hp} temporary HP.${retained ? ` ${retained} dice retained by Perun.` : ''}${emergency ? ' Emergency recovery uses the explicit 1 HP table ruling.' : ''}</p>`,
      { rolls: roll ? [roll] : [] }
    )
  );
}
export async function endAdrenalineCombat(actor, combatId) {
  const ending = actor.system.effects.filter((effect) => effect.adrenaline?.combatId === combatId);
  if (!ending.length && actor.flags?.[SYSTEM_ID]?.adrenaline?.combatId !== combatId) return;
  const hp = actor.system.hp.value - ending.reduce((sum, effect) => sum + (effect.temporaryHp || 0), 0);
  await commitActor(actor, {
    [`flags.${SYSTEM_ID}.-=adrenaline`]: null,
    'system.effects': actor.system.effects.filter((effect) => !ending.includes(effect)),
    'system.hp.value': hp,
    ...(hp <= 0 && actor.system.hp.value > 0
      ? { 'system.pendingDeathSaves': actor.system.pendingDeathSaves + 1 }
      : {}),
  });
}
export function registerAdrenalineSetting() {
  game.settings.register(SYSTEM_ID, 'adrenaline', {
    name: 'Optional rule: Adrenaline',
    hint: 'Core p.175: critical hits grant dice; each die costs 10 STA for damage or temporary HP. Maribor Forest requires this rule.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });
}
export function registerAdrenaline() {
  registerCommand('adrenalineHP', executeAdrenalineHP);
  const cleanup = (combat) => {
    if (!isPrimaryActiveGm()) return;
    serial('witcher-authority', async () => {
      const actors = new Map(
        [
          ...(game.actors ?? []),
          ...[...(game.scenes ?? [])].flatMap((scene) =>
            [...scene.tokens].map((token) => token.actor).filter(Boolean)
          ),
        ].map((actor) => [actor.uuid, actor])
      );
      for (const actor of actors.values()) await endAdrenalineCombat(actor, combat.id);
    }).catch(errorNotice);
  };
  Hooks.on('deleteCombat', cleanup);
  Hooks.on('updateCombat', (combat, changes) => {
    if (changes.round === 0) cleanup(combat);
  });
}
