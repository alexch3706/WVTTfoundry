/** Pure equipment rules from A Witcher's Tools, printed pp.3–5.
 *
 * These helpers return calculations/choices only. The combat workflow owns
 * permissions, rolls, idempotence, immediate availability and consumption.
 */

export const SCHOOL_PERKS = Object.freeze({
  criticalDecimation: { name: 'Critical Decimation', trigger: 'critical', page: 3 },
  criticalFlurry: { name: 'Critical Flurry', trigger: 'critical', page: 3 },
  criticalSpellcasting: { name: 'Critical Spellcasting', trigger: 'critical', page: 4 },
  criticalBlock: { name: 'Critical Block', trigger: 'defense', page: 4 },
  criticalRiposte: { name: 'Critical Riposte', trigger: 'defense', page: 4 },
  criticalMomentum: { name: 'Critical Momentum', trigger: 'critical', page: 5 },
});

const TIERS = ['simple', 'complex', 'difficult', 'deadly'];
const BONUSES = { simple: 3, complex: 5, difficult: 8, deadly: 10 };
const system = (item) => item?.system ?? item;
const kind = (item) => item?.type ?? system(item)?.type;
const id = (item) => item?.id ?? item?._id ?? '';

/** Accepts an actor snapshot (items with flattened system fields) or documents. */
export function equippedSchoolPerks(state) {
  const items = state?.items ?? [];
  return [...items]
    .filter((item) => {
      const s = system(item);
      return (
        kind(item) === 'armor' &&
        s.equipped === true &&
        s.carried !== false &&
        Number(s.quantity ?? 1) > 0 &&
        Object.hasOwn(SCHOOL_PERKS, s.ability?.key)
      );
    })
    .map((item) => {
      const s = system(item),
        key = s.ability.key;
      return {
        key,
        ...SCHOOL_PERKS[key],
        sourceItemId: id(item),
        sourceItemName: item.name ?? '',
        school: s.school ?? '',
        source: 'A Witcher’s Tools',
      };
    });
}

export function isWitcherWeapon(weapon) {
  return ['weapon', 'shield'].includes(kind(weapon)) && system(weapon)?.witcherWeapon === true;
}

/**
 * Upgrade a rolled critical by one tier for Ursine Armor before selecting its
 * wound table. No attack margin is manufactured; the new tier supplies its own
 * critical bonus under Core p.158. Deadly is the final published tier, so a
 * capped result explicitly reports the source's undefined higher-tier case.
 */
export function adjustSchoolCritical(state, weapon, severity) {
  if (!severity) return null;
  const index = TIERS.indexOf(severity.level);
  if (index < 0) throw new RangeError(`Unknown critical severity: ${severity.level}`);
  const armor = equippedSchoolPerks(state).find((perk) => perk.key === 'criticalDecimation');
  if (!armor || !isWitcherWeapon(weapon)) return { ...severity };
  const level = TIERS[Math.min(index + 1, TIERS.length - 1)];
  return {
    ...severity,
    level,
    bonus: BONUSES[level],
    schoolAdjustment: {
      key: armor.key,
      sourceItemId: armor.sourceItemId,
      sourceItemName: armor.sourceItemName,
      from: severity.level,
      to: level,
      capped: index === TIERS.length - 1,
      note:
        index === TIERS.length - 1
          ? 'A Witcher’s Tools defines no critical tier above Deadly; GM adjudication is required for any further effect.'
          : '',
    },
  };
}

const strike = () => ({
  key: 'strike',
  label: 'Single strike',
  action: 'normal',
  style: 'normal',
  singleStrike: true,
  weaponRequirement: 'held',
  targetConstraint: 'normal',
});

function choices(key) {
  switch (key) {
    case 'criticalFlurry':
      return [
        { key: 'disarm', label: 'Disarm', action: 'disarm', singleStrike: true, targetConstraint: 'normal' },
        { key: 'trip', label: 'Trip', action: 'trip', singleStrike: true, targetConstraint: 'normal' },
      ];
    case 'criticalBlock':
      return [
        {
          key: 'shieldStrike',
          label: 'Shield strike',
          action: 'normal',
          style: 'normal',
          singleStrike: true,
          weaponRequirement: 'manticoreShield',
          targetConstraint: 'triggeringAttacker',
          onHit: { knockbackMeters: 4, conditions: ['prone'] },
        },
      ];
    case 'criticalRiposte':
    case 'criticalMomentum':
      return [strike()];
    case 'criticalSpellcasting':
      return [
        {
          key: 'sign',
          label: 'Cast a Sign',
          action: 'sign',
          cost: 'signOnly',
          deferred: false,
          targetConstraint: 'normal',
        },
      ];
    default:
      return [];
  }
}

/**
 * Describe immediate choices granted by a resolved attack or defense.
 *
 * Critical context: {trigger:'critical', weapon, criticalCaused:true}.
 * Defense context: {trigger:'defense', weapon, defense:'blockWeapon'|'blockShield'|'parry',
 *                  attackTotal, defenseTotal}.
 * `weapon` is the triggering attack weapon or the selected defending item.
 * Any eventId supplied by the caller is carried through for one-time processing.
 *
 * The text says "whenever" and provides no reaction-chain prohibition. A valid
 * critical caused by a previous reaction can therefore grant another choice.
 */
export function schoolReactions(state, context = {}) {
  const { trigger, weapon, criticalCaused = false, defense, attackTotal, defenseTotal } = context;
  const margin = Number(defenseTotal) - Number(attackTotal);
  const witcher = isWitcherWeapon(weapon);
  return equippedSchoolPerks(state)
    .filter((perk) => {
      if (perk.trigger !== trigger || perk.key === 'criticalDecimation') return false;
      if (trigger === 'critical') return criticalCaused && witcher;
      if (trigger !== 'defense' || !Number.isFinite(margin) || margin <= 4) return false;
      if (perk.key === 'criticalRiposte') return defense === 'parry' && witcher;
      if (perk.key === 'criticalBlock')
        return (
          ['blockWeapon', 'blockShield', 'parry'].includes(defense) &&
          kind(weapon) === 'shield' &&
          system(weapon)?.school === 'manticore' &&
          witcher
        );
      return false;
    })
    .map((perk) => ({
      ...perk,
      eventId: context.eventId ?? '',
      immediate: true,
      choiceCount: 1,
      additionalStamina: 0,
      additionalPenalty: 0,
      spendAction: false,
      deferred: false,
      choices: choices(perk.key),
    }));
}
