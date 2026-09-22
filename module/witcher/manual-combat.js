import { SYSTEM_ID } from './config.js';
import { RuleError, locate } from './rules.js';
import { criticalWound } from './wounds.js';
import { actorSnapshot } from './documents.js';
import { magicDamageSnapshot } from './magic-shields.js';
import { authorizedActor, runCommand } from './authority.js';
import { prompt, input, escapeHTML as e, actorFromUuid } from './runtime.js';

export const manualCombatEnabled = (actor) => actor?.system?.manualCombat === true;

/** Bounded arithmetic grammar: no eval, substitutions, dice modifiers or random fallback. */
export function manualFormula(formula) {
  if (typeof formula !== 'string' || formula.length > 250) throw new RuleError('Invalid damage formula.');
  const text = formula.replace(/\s+/g, '').toLowerCase();
  const tokens = text.match(/\d*d\d+|\d+(?:\.\d+)?|[()+*/-]/g) ?? [];
  if (!tokens.length || tokens.join('') !== text)
    throw new RuleError(`Manual dice require ordinary dice and arithmetic: ${formula}`);
  const groups = [];
  for (const token of tokens)
    if (token.includes('d')) {
      const [count, faces] = token.split('d').map(Number),
        number = count || 1;
      if (number > 100 || faces < 2 || faces > 1000 || token.startsWith('0d')) {
        if (token === '0d6') continue;
        throw new RuleError('Unsupported number or size of dice.');
      }
      groups.push({ number, faces });
    }
  const count = groups.reduce((sum, group) => sum + group.number, 0);
  if (count > 100) throw new RuleError('At most 100 manual dice per roll.');
  const evaluate = (values) => {
    let index = 0,
      dieIndex = 0,
      groupIndex = 0;
    const atom = () => {
      const token = tokens[index++];
      if (token === '+' || token === '-') return (token === '-' ? -1 : 1) * atom();
      if (token === '(') {
        const value = sum();
        if (tokens[index++] !== ')') throw new RuleError('Unbalanced damage formula.');
        return value;
      }
      if (token === '0d6') return 0;
      if (token?.includes('d')) {
        const group = groups[groupIndex++];
        return values.slice(dieIndex, (dieIndex += group.number)).reduce((a, b) => a + b, 0);
      }
      if (!/^\d+(?:\.\d+)?$/.test(token ?? '')) throw new RuleError('Invalid damage formula.');
      return Number(token);
    };
    const product = () => {
      let value = atom();
      while (['*', '/'].includes(tokens[index])) {
        const op = tokens[index++],
          right = atom();
        value = op === '*' ? value * right : value / right;
      }
      return value;
    };
    const sum = () => {
      let value = product();
      while (['+', '-'].includes(tokens[index])) {
        const op = tokens[index++],
          right = product();
        value = op === '+' ? value + right : value - right;
      }
      return value;
    };
    const total = sum();
    if (index !== tokens.length || !Number.isFinite(total)) throw new RuleError('Invalid damage formula.');
    return total;
  };
  evaluate(Array(count).fill(1));
  return { groups, count, evaluate };
}
export function manualFormulaResult(formula, entered = '') {
  const parsed = manualFormula(formula);
  if (typeof entered !== 'string' || (parsed.count && !/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(entered)))
    throw new RuleError('Enter the individual dice, separated by commas.');
  const values = entered.trim() ? entered.split(',').map((value) => Number(value.trim())) : [];
  if (values.length !== parsed.count)
    throw new RuleError(
      `Enter exactly ${parsed.count} dice for ${formula}; fixed bonuses are added automatically.`
    );
  let offset = 0;
  const dice = parsed.groups.map((group) => ({
    faces: group.faces,
    results: values.slice(offset, (offset += group.number)).map((result) => {
      if (!Number.isInteger(result) || result < 1 || result > group.faces)
        throw new RuleError(`Each d${group.faces} must be between 1 and ${group.faces}.`);
      return { result, active: true };
    }),
  }));
  return { formula, total: parsed.evaluate(values), dice, manual: true };
}
export class ManualDamageRequest extends Error {
  constructor(request) {
    super('Waiting for physical dice.');
    this.request = request;
  }
}
function freezeEffects(state) {
  const time = game.time.worldTime;
  return {
    ...state,
    effects: (state.effects ?? [])
      .filter((effect) => !effect.expires || effect.expires > time)
      .map((effect) => ({ ...effect, expires: 0 })),
  };
}
export function manualDamageSession(attacker, target, defense, fingerprint, baseContent) {
  return {
    version: 1,
    revision: 0,
    status: 'pending',
    answers: {},
    request: null,
    history: [],
    source: freezeEffects({
      ...actorSnapshot(attacker),
      derived: foundry.utils.deepClone(attacker.system.derived),
    }),
    target: freezeEffects({
      ...magicDamageSnapshot(target),
      derived: foundry.utils.deepClone(target.system.derived),
    }),
    defense: foundry.utils.deepClone(defense),
    time: game.time.worldTime,
    fingerprint,
    baseContent,
  };
}
export function manualDamageIO(session) {
  const history = [];
  const requestValue = (request) => {
    const answer = session.answers[request.key];
    if (!answer) throw new ManualDamageRequest(request);
    return answer;
  };
  return {
    manual: true,
    source: session.source,
    target: session.target,
    time: session.time,
    fingerprint: session.fingerprint,
    history,
    roll: async (formula, key, label) => {
      if (!manualFormula(formula).count) return manualFormulaResult(formula);
      const request = { kind: 'dice', key, label: label ?? key, formula };
      const answer = requestValue(request),
        result = manualFormulaResult(formula, answer.dice);
      if (!history.some((row) => row.key === key))
        history.push({ key, label: request.label, formula, dice: answer.dice, total: result.total });
      return result;
    },
    location: async (table) => {
      const locations = table
        .filter((location) => location.min >= 1 && location.max <= 10)
        .map(({ id, label, min, max, aim, multiplier }) => ({ id, label, min, max, aim, multiplier }));
      const answer = requestValue({ kind: 'location', key: 'location', label: 'Hit location', locations });
      const location = answer.location
        ? locate(locations, answer.location)
        : locate(locations, manualFormulaResult('1d10', answer.dice).total);
      history.push({
        key: 'location',
        label: 'Hit location',
        choice: location.label,
        ...(answer.dice ? { formula: '1d10', dice: answer.dice } : {}),
      });
      return locate(table, location.id);
    },
    chooseCritical: async (choices) => {
      const options = Object.fromEntries(
        choices.map((choice, index) => [
          index,
          `${choice.wound?.name ?? 'Organless: damage bonus'} · ${choice.location.label}`,
        ])
      );
      const answer = requestValue({
        kind: 'choice',
        key: 'critical-choice',
        label: 'Griffin trophy: keep a rolled critical result',
        options,
      });
      if (!Object.hasOwn(options, answer.choice))
        throw new RuleError('Choose one of the rolled critical results.');
      history.push({ key: 'critical-choice', label: 'Critical result', choice: options[answer.choice] });
      return { critical: answer.choice };
    },
  };
}
export function validateManualDamageAnswer(request, values) {
  if (!request) throw new RuleError('Resume the saved damage calculation before entering dice.');
  if (request.kind === 'dice') {
    manualFormulaResult(request.formula, values.dice);
    return { dice: values.dice.trim() };
  }
  if (request.kind === 'location') {
    if (values.location) {
      if (values.dice?.trim()) throw new RuleError('Choose a location or enter the location die, not both.');
      if (!request.locations.some((location) => location.id === values.location))
        throw new RuleError('Choose a location from this target’s anatomy.');
      return { location: values.location };
    }
    locate(request.locations, manualFormulaResult('1d10', values.dice).total);
    return { dice: values.dice.trim() };
  }
  if (request.kind === 'choice' && Object.hasOwn(request.options, values.choice))
    return { choice: String(values.choice) };
  throw new RuleError('Invalid manual damage choice.');
}
export function manualDamageHTML(session, { complete = false } = {}) {
  const history = session.history
    .map(
      (row) =>
        `<li>${e(row.label)}: ${row.dice ? `${e(row.formula)} · [${e(row.dice)}]${row.total !== undefined ? ` = ${row.total}` : ''}` : ''}${row.choice ? e(row.choice) : ''}</li>`
    )
    .join('');
  return `<section class="manual-combat"><h4>Physical combat dice${complete ? ' — recorded' : ''}</h4>${history ? `<ul>${history}</ul>` : ''}${complete ? '' : `<p>${e(session.request?.label ?? 'Continue saved damage calculation')}. Waiting for the attacker’s owner or GM.</p><button type="button" data-witcher-action="manualDamage">${session.request ? 'Enter physical dice' : 'Resume damage'}</button>`}</section>`;
}
export async function enterManualDamage(message, { ask = prompt } = {}) {
  const actor = await actorFromUuid(message.flags?.[SYSTEM_ID]?.actorUuid);
  if (!actor?.isOwner) throw new RuleError('The attacker’s owner or GM enters these dice.');
  while (true) {
    const data = message.flags[SYSTEM_ID],
      state = data.manualDamage;
    if (data.resolved || !state || state.status === 'complete') return;
    const request = state.request;
    let values;
    if (request) {
      let fields = manualDamageHTML({ ...state, request: null }, { complete: true });
      if (request.kind === 'location')
        fields +=
          input('location', 'Recorded hit location', {
            options: {
              '': 'Enter the d10 result',
              ...Object.fromEntries(request.locations.map((loc) => [loc.id, loc.label])),
            },
          }) + input('dice', 'Location d10 (no exploding dice)', { type: 'text' });
      else if (request.kind === 'choice')
        fields += input('choice', request.label, { options: request.options });
      else
        fields +=
          `<p>${e(request.formula)}: enter the individual dice. Fixed bonuses are added automatically.</p>` +
          input('dice', 'Dice, separated by commas', { type: 'text' });
      values = await ask(`${actor.name}: ${request.label}`, fields, {
        button: 'Record and continue',
        validate: (values) => validateManualDamageAnswer(request, values),
      });
      if (!values) return;
    }
    await runCommand(
      'manualDamage',
      { messageUuid: message.uuid, revision: state.revision, values },
      { label: `${actor.name}: physical combat dice` }
    );
    // The command receipt follows the authoritative attack-card update on clients.
    message = await foundry.utils.fromUuid(message.uuid);
  }
}
export async function submitManualDamage({ messageUuid, revision, values }, { user, id }) {
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags?.[SYSTEM_ID];
  if (!message?.author?.isGM || data?.kind !== 'attack' || !data.manualCombat)
    throw new RuleError('Choose a GM-authorized manual attack.');
  await authorizedActor(data.actorUuid, user);
  if (data.resolved || data.manualDamage?.status === 'complete')
    throw new RuleError('This attack already has its damage result.');
  const session = foundry.utils.deepClone(data.manualDamage);
  if (!session || session.revision !== revision)
    throw new RuleError('The manual dice card changed. Reopen its current input.');
  if (session.request) {
    session.answers[session.request.key] = {
      ...validateManualDamageAnswer(session.request, values ?? {}),
      authorId: user.id,
      operationId: id,
    };
    session.revision++;
    session.request = null;
    await message.update({
      [`flags.${SYSTEM_ID}.manualDamage`]: session,
      content: session.baseContent + manualDamageHTML(session),
    });
  } else if (values) throw new RuleError('There is no pending dice input. Resume the saved calculation.');
  const { finishWeaponDamage } = await import('./combat.js');
  return finishWeaponDamage(message, session.defense);
}

/** Ask only for dice that affect this critical; retain invalid anatomical rolls before rerolling. */
export async function manualCriticalWound(level, table, options, { roll, rolls, key = 'critical' }) {
  const record = async (formula, suffix, label) => {
    const result = await roll(formula, `${key}-${suffix}`, label);
    rolls.push(result);
    return result.total;
  };
  if (options.aimed) {
    const lower = criticalWound(level, table, { ...options, greater: 1 });
    const upper = criticalWound(level, table, { ...options, greater: 6 });
    if (JSON.stringify(lower) === JSON.stringify(upper)) return lower;
    const greater = await record('1d6', 'variant', 'Critical injury variant');
    return criticalWound(level, table, { ...options, greater });
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await record(
      '2d6',
      attempt ? `reroll-${attempt}` : 'location',
      attempt ? 'Critical location absent from target: reroll 2d6 (p.159)' : 'Critical injury and location'
    );
    let result;
    try {
      result = criticalWound(level, table, { ...options, roll: value, side: 1 });
    } catch (error) {
      if (error instanceof RuleError && /Reroll the critical location/.test(error.message)) continue;
      throw error;
    }
    const other = criticalWound(level, table, { ...options, roll: value, side: 2 });
    if (result.location.id === other.location.id) return result;
    // Both Griffin-trophy alternatives use the same side die, as in automatic combat.
    const side = await roll('1d6', 'critical-side', 'Critical limb side');
    rolls.push(side);
    return criticalWound(level, table, { ...options, roll: value, side: side.total });
  }
  throw new RuleError('No valid critical location after 100 recorded rolls. Check the target anatomy.');
}
