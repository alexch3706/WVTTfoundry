import { HUMANOID_LOCATIONS, MONSTER_LOCATIONS, SKILLS, STATS, CONDITIONS } from './config.js';
import { criticalHealingDays } from './rules.js';
import { woundModifiers } from './wounds.js';
import { healingRequirements, recoveryPlan, woundStageLabel } from './wound-rules.js';
import { woundInfo } from './wound-catalog.js';

const stageKeys = ['untreated', 'stabilized', 'treated', 'healed'];
const title = (text) =>
  String(text ?? '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
const modifierLabels = {
  armActions: 'Actions using the injured limb',
  armDisabled: 'Injured limb',
  allActions: 'All actions',
  sightAwareness: 'Awareness using sight',
  criticalHealing: 'Critical Healing',
  enc: 'Encumbrance capacity (kg)',
  bleedingDamage: 'Bleeding damage each round',
  headMultiplier: 'Damage to the head',
};

/** Readable labels for the actual modifiers used by the rules engine. */
export function woundModifierRows(modifiers = {}) {
  return Object.entries(modifiers)
    .filter(([, value]) => Number(value) !== 0)
    .map(([key, value]) => {
      const multiplier = key.endsWith('Multiplier');
      const base = multiplier ? key.slice(0, -10) : key;
      return {
        key,
        label:
          modifierLabels[key] ??
          modifierLabels[base] ??
          SKILLS[base]?.[0] ??
          (STATS.includes(base) || ['rec', 'sta', 'stun'].includes(base) ? base.toUpperCase() : title(base)),
        value:
          key === 'armDisabled'
            ? 'Unusable'
            : multiplier
              ? `×${value}`
              : Number(value) > 0
                ? `+${value}`
                : String(value),
      };
    });
}

/** One view model for embedded cards, world Items, and compendium source Items. */
export function woundDisplay(
  item,
  { actor = item.actor, isGM = false, isOwner = actor?.isOwner ?? false } = {}
) {
  const system = item.system ?? item;
  const wound = system.wound ?? {};
  const info = woundInfo({ ...wound, name: wound.name || item.name });
  const stage = stageKeys.includes(wound.treatment) ? wound.treatment : 'untreated';
  const state = actor?.system ?? actor;
  const items =
    actor?.items?.map((i) => ({
      id: i.id,
      type: i.type,
      name: i.name,
      ...(i.system?.toObject?.() ?? i.system ?? i),
    })) ?? [];
  const locations = [
    ...HUMANOID_LOCATIONS,
    ...MONSTER_LOCATIONS,
    ...(state?.locationTable ?? state?.locations ?? []),
  ];
  const location = locations.findLast((entry) => entry.id === wound.location)?.label ?? wound.location;
  const requirements = healingRequirements(wound.severity);
  const owned = !!actor;
  const permanent = !!wound.permanent;
  const fatal = !!wound.fatal;
  const plan = owned && !fatal ? recoveryPlan(state, items, { ...wound, itemId: item.id }) : null;
  const modifiers = woundModifierRows(woundModifiers({ ...wound, treatment: stage }) ?? {});
  let recovery;
  if (fatal) recovery = 'Fatal injury. Ordinary stabilization and treatment cannot reverse it.';
  else if (permanent)
    recovery =
      stage === 'healed'
        ? 'Healed with a lasting consequence. Keep this card to retain its effects.'
        : 'Permanent injury. The book gives no ordinary recovery period; treatment does not restore what was lost.';
  else if (stage === 'healed')
    recovery = 'Recovery complete. This card remains as a record without temporary penalties.';
  else if (stage === 'treated')
    recovery = wound.recoveryPending
      ? 'GM recovery time required.'
      : `${Number(wound.daysRemaining) || 0} days remaining${wound.daysTotal > 0 ? ` of ${wound.daysTotal}` : ''}.`;
  else if (owned && plan?.days !== null && plan?.days !== undefined)
    recovery = `${plan.days} day${plan.days === 1 ? '' : 's'} after successful treatment (BODY ${plan.body}). Stabilization alone does not start recovery.`;
  else recovery = 'Recovery starts after successful treatment. Stabilization alone does not start recovery.';
  const editable = owned && isOwner;
  const needsTreatment = !fatal && ['untreated', 'stabilized'].includes(stage);
  const legacyConditions =
    !wound.separateConditions &&
    owned &&
    ['bleeding', 'poison', 'suffocating'].some(
      (condition) => wound[condition] && state.conditions?.includes(condition)
    );
  const contextual = [];
  if (stage === 'untreated' && wound.endedConditions?.length)
    contextual.push(
      `Stopped separately: ${wound.endedConditions.map((key) => CONDITIONS[key] ?? title(key)).join(', ')}. Other injury effects remain active.`
    );
  if (Object.keys(wound.modifiers ?? {}).some((key) => key.startsWith('arm')))
    contextual.push(
      'Limb penalties apply when that limb is used; choose the relevant limb when a check asks.'
    );
  if (Object.hasOwn(wound.modifiers ?? {}, 'sightAwareness'))
    contextual.push('The Awareness penalty applies only to checks using sight.');
  return {
    id: item.id,
    name: item.name ?? wound.name,
    img: item.img,
    severity: title(wound.severity),
    stage,
    stageLabel: woundStageLabel({ ...wound, treatment: stage }),
    location:
      location ||
      (owned
        ? 'No location selected'
        : `${title(info?.group ?? wound.group ?? 'affected location')} — choose when adding to an actor`),
    owned,
    editable,
    permanent,
    fatal,
    known: !!info,
    activeText: info?.stages?.[stage] ?? system.effectText ?? '',
    modifiers,
    stages: stageKeys.map((key) => ({
      key,
      label: woundStageLabel({ ...wound, treatment: key }),
      text: info?.stages?.[key] ?? '',
      current: owned && key === stage,
    })),
    note: info?.note ?? '',
    contextual,
    notes: wound.notes ?? '',
    extraResult: wound.extraResult > 0 ? wound.extraResult : null,
    extraLabel: wound.extraRoll ? `${wound.extraRoll} result` : 'Additional injury result',
    requirements,
    roundsCompleted: Number(wound.turnsTreated) || 0,
    magicCompleted: Number(wound.magicUses) || 0,
    recovery,
    recoveryReason:
      !fatal && !permanent && stage !== 'healed' && (wound.recoveryPending || stage !== 'treated')
        ? (plan?.reason ?? '')
        : '',
    recoveryBody: stage === 'treated' && wound.recoveryBody ? wound.recoveryBody : plan?.body,
    recoveryTable:
      !owned && !permanent && !fatal
        ? Array.from({ length: 11 }, (_, index) => ({
            body: index + 3,
            days: criticalHealingDays(index + 3, wound.severity),
          }))
        : [],
    legacyNotice: legacyConditions
      ? 'Older wound: any separately marked Bleeding, Poison, or Suffocating must be reviewed on the actor after treatment.'
      : '',
    canMedical: editable && needsTreatment,
    canMarkStabilized: editable && isGM && !fatal && stage === 'untreated',
    canMarkTreated: editable && isGM && needsTreatment,
    canMagic: editable && isGM && needsTreatment,
    canDays: editable && !fatal && !permanent && stage === 'treated' && (!wound.recoveryPending || isGM),
    daysLabel: wound.recoveryPending ? 'Set recovery time (GM)' : 'Recovery days',
    canHeal: editable && isGM && !fatal && stage === 'treated',
    healLabel: permanent ? 'Mark healed · lasting consequence (GM)' : 'Mark healed (GM)',
  };
}
