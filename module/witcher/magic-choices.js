import { requiredChoices, spellEffectPlan } from './magic-effects.js';
import { RuleError } from './rules.js';
import { input, escapeHTML } from './runtime.js';

const label = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (s) => s.toUpperCase());
const rows = (collection) => Array.from(collection?.values?.() ?? collection ?? []);

/** Choices describe book decisions; UUIDs are checked again by the GM executor. */
export function magicChoiceFields(magic, caster, target) {
  let html = '';
  for (const choice of requiredChoices(magic)) {
    if (choice.type === 'point') continue;
    const name = `choice_${choice.key}`;
    if (choice.reason) html += `<p class="notes">${escapeHTML(choice.reason)}</p>`;
    const title = `${choice.label ?? label(choice.key)}${choice.gm ? ' (GM ruling)' : ''}`;
    if (choice.type === 'enum')
      html += input(name, title, { options: Object.fromEntries(choice.options.map((v) => [v, label(v)])) });
    else if (choice.type === 'boolean') html += input(name, title, { type: 'checkbox' });
    else if (choice.type === 'number')
      html += input(name, title, {
        value: choice.min ?? 0,
        min: choice.min,
        max: choice.max,
        step: choice.integer ? 1 : 'any',
      });
    else if (choice.type === 'item') {
      const healingWound =
        choice.key === 'wound' &&
        ['magic-healing', 'blessing-of-healing', 'miracle-of-lebioda'].includes(magic.key);
      const items = [
        ...new Map(
          (healingWound ? [target] : [caster, target])
            .filter(Boolean)
            .flatMap((actor) => rows(actor.items))
            .map((item) => [item.uuid, item])
        ).values(),
      ];
      html += input(name, title, {
        options: {
          '': 'Choose an owned item',
          ...Object.fromEntries(
            items
              .filter(
                (item) =>
                  !healingWound ||
                  (item.type === 'wound' &&
                    !item.system.wound.fatal &&
                    (magic.key === 'miracle-of-lebioda'
                      ? item.system.wound.treatment !== 'healed' ||
                        item.system.wound.permanent ||
                        (item.system.wound.key === 'complex-4' && item.system.wound.extraResult > 0)
                      : ['untreated', 'stabilized'].includes(item.system.wound.treatment)))
              )
              .filter((item) => !choice.requiresProperty || item.system.properties?.[choice.requiresProperty])
              .map((item) => [item.uuid, `${item.parent?.name ?? ''}: ${item.name}`])
          ),
        },
      });
    } else if (choice.type === 'actor') {
      html += input(name, title, {
        options: {
          '': 'Choose a creature',
          ...Object.fromEntries(
            rows(globalThis.canvas?.scene?.tokens)
              .filter((token) => token.actor && !token.hidden)
              .map((token) => [token.actor.uuid, token.name])
          ),
        },
      });
    } else if (choice.type === 'effect') {
      html += input(name, title, {
        options: {
          '': 'Choose a magical effect',
          ...Object.fromEntries(
            [caster, target]
              .filter(Boolean)
              .flatMap((actor) =>
                actor.system.effects
                  .filter((effect) => effect.magic)
                  .map((effect) => [`${actor.uuid}#${effect.id}`, `${actor.name}: ${effect.key}`])
              )
          ),
        },
      });
    } else html += input(name, title, { type: 'text' });
  }
  return html;
}

export function readMagicChoices(magic, values) {
  const choices = {};
  for (const descriptor of requiredChoices(magic)) {
    const value = values[`choice_${descriptor.key}`];
    if (value === undefined || value === '') continue;
    choices[descriptor.key] =
      descriptor.type === 'number' ? Number(value) : descriptor.type === 'boolean' ? !!value : value;
  }
  return choices;
}

export async function validateMagicChoices(magic, choices, { caster, targets, user, resolveUuid }) {
  const descriptors = requiredChoices(magic);
  for (const descriptor of descriptors) {
    if (descriptor.when && choices[descriptor.when.key] !== descriptor.when.equals) continue;
    const value = choices[descriptor.key];
    if (value === undefined && !descriptor.required) continue;
    if (descriptor.gm && !user.isGM)
      throw new RuleError(`The GM must declare ${label(descriptor.key)} for this casting.`);
    if (['item', 'actor'].includes(descriptor.type)) {
      const doc = await resolveUuid(value);
      if (!doc) throw new RuleError(`The selected ${descriptor.key} is missing.`);
      const actor = descriptor.type === 'item' ? doc.parent : doc;
      if (![caster, ...targets].some((row) => row.uuid === actor?.uuid))
        throw new RuleError(`${label(descriptor.key)} must belong to this casting’s caster or targets.`);
      if (descriptor.requiresProperty && !(doc.system.properties?.[descriptor.requiresProperty] > 0))
        throw new RuleError(`The selected item lacks ${descriptor.requiresProperty}.`);
      if (descriptor.consumable && (!(doc.system.quantity >= 1) || doc.system.carried === false))
        throw new RuleError('Select an actual carried seed with at least one unit remaining.');
      if (
        descriptor.meleeOnly &&
        ['bow', 'crossbow', 'thrown', 'bomb', 'naturalRanged'].includes(doc.system.category)
      )
        throw new RuleError('Choose a melee weapon.');
      if (descriptor.metalOnly && !user.isGM)
        throw new RuleError('The GM must confirm that the selected item is metal.');
      if (descriptor.fromAuthoritativeItem) delete choices[descriptor.key];
    }
  }
  // The pure planner validates enums, numbers, mutually exclusive choices and prerequisites.
  const plan = spellEffectPlan(magic, { castTotal: 0, choices });
  const missing = plan.requirements.filter((requirement) => requirement.type === 'choice');
  if (missing.length)
    throw new RuleError(
      `Complete the spell choices: ${missing.map((entry) => label(entry.key)).join(', ')}.`
    );
  return choices;
}
