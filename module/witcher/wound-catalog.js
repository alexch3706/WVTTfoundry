import { WOUNDS } from './wounds.js';

const noPenalty = 'The wound has healed. Its temporary penalties no longer apply.';
const verbal = 'Charisma, Persuasion, Seduction, Leadership, Deceit, Social Etiquette, and Intimidation';
const empathetic = 'Charisma, Persuasion, Seduction, Leadership, Deceit, and Social Etiquette';
const magic = 'Spell Casting, Hex Weaving, and Ritual Crafting';
const anatomy = ['leg', 'arm', 'torso', 'torso', 'head', 'head'];

// Each row follows the 2d6 order in WOUNDS: 2–3, 4–5, 6–8, 9–10, 11, 12.
// These are paraphrased reference descriptions; WOUNDS remains the mechanical source.
const descriptions = {
  simple: [
    ['SPD, Dodge/Escape, and Athletics −2.', 'SPD, Dodge/Escape, and Athletics −1.', 'SPD −1.'],
    ['Actions using the injured arm −2.', 'Actions using the injured arm −1.', 'Physique −1.'],
    [
      'REC and critical-wound recovery operate at one quarter of their normal rate.',
      'REC and critical-wound recovery operate at one half of their normal rate.',
      'REC −2 and Critical Healing −1.',
      noPenalty,
      'Core p.158 does not define a separate Critical Healing statistic. The recovery table on p.174 uses BODY to give days. The exact arithmetic for the treated −1 is not specified. The GM must set the duration while this Critical Healing modifier is relevant. The infection slows recovery of other treated wounds too.',
    ],
    ['BODY −2; maximum HP does not change.', 'BODY −1.', 'Encumbrance capacity −10.'],
    [
      `${empathetic}: −3. Intimidation is unaffected.`,
      `${empathetic}: −1. Intimidation is unaffected.`,
      'Seduction −1.',
    ],
    [`${magic} and ${verbal}: −2.`, `${magic} and ${verbal}: −1.`, `${magic}: −1.`],
  ],
  complex: [
    [
      'SPD, Dodge/Escape, and Athletics −3.',
      'SPD, Dodge/Escape, and Athletics −2.',
      'SPD, Dodge/Escape, and Athletics −1.',
    ],
    [
      'Actions using the injured arm −3.',
      'Actions using the injured arm −2.',
      'Actions using the injured arm −1.',
    ],
    ['BODY −2; REF and DEX −1.', 'BODY and REF −1.', 'BODY −1.'],
    [
      'Bleeding begins. Make a Stun save every 5 rounds.',
      'Wound-induced bleeding ends. Make a Stun save every 10 rounds.',
      'STUN −2. This wound no longer requires periodic Stun saves.',
    ],
    [
      `Lose 1d10 teeth. ${magic} and ${verbal}: −3.`,
      `${magic} and ${verbal}: −2.`,
      `${magic} and ${verbal}: −1.`,
      'The temporary skill penalties end. Keep the recorded number of lost teeth as part of the injury history.',
      'Roll 1d10 once when the injury is acquired and record how many teeth were lost. Changing treatment does not roll again or regrow teeth.',
    ],
    ['INT, WILL, and STUN −1.', 'INT and WILL −1.', 'WILL −1.'],
  ],
  difficult: [
    [
      'SPD, Dodge/Escape, and Athletics are quartered. Bleeding begins.',
      'SPD, Dodge/Escape, and Athletics are halved. Wound-induced bleeding ends.',
      'SPD, Dodge/Escape, and Athletics −2.',
    ],
    [
      'The injured arm cannot be used. Bleeding begins.',
      'The injured arm cannot be used. Wound-induced bleeding ends.',
      'Keep the arm in a sling. It can hold an object but cannot perform normal arm actions.',
      noPenalty,
      'Treatment permits holding things, not wielding a weapon or otherwise using the arm normally. This restriction ends after healing.',
    ],
    [
      'BODY and SPD −3. Suffocation begins: 3 damage per round, ignoring armor.',
      'BODY and SPD −2. Suffocation caused by this wound ends.',
      'BODY and SPD −1.',
    ],
    [
      'All actions −2. Suffer 4 acid damage per round.',
      'All actions −2. The recurring acid damage ends.',
      'All actions −1.',
    ],
    [
      'INT, REF, and DEX −2. Roll 1d6 once; make a Stun save after each interval of that many rounds.',
      'INT, REF, and DEX −1. This wound no longer requires periodic Stun saves.',
      'INT and DEX −1.',
      noPenalty,
      'Record the 1d6 round interval when the injury is acquired. Stabilizing the wound stops its recurring Stun saves.',
    ],
    [
      'INT and DEX −1. Head damage uses a ×4 location multiplier. Bleeding begins.',
      'INT and DEX −1. Head damage still uses ×4. Wound-induced bleeding ends.',
      'Head damage uses a ×4 location multiplier.',
      noPenalty,
      'The ×4 multiplier replaces the normal head-location multiplier; it is not an additional ×4 applied after that multiplier.',
    ],
  ],
  deadly: [
    [
      'The leg is lost or permanently unusable. SPD, Dodge/Escape, and Athletics are quartered. Bleeding begins.',
      'SPD, Dodge/Escape, and Athletics remain quartered. Wound-induced bleeding ends.',
      'The missing or unusable leg can be replaced with a prosthesis. Without a prosthesis, the quartered SPD, Dodge/Escape, and Athletics remain.',
      'Permanent consequence: the leg remains missing or unusable. SPD, Dodge/Escape, and Athletics remain quartered unless a prosthesis changes these penalties.',
      'Core p.174 gives no healing duration for Deadly wounds. A healed label does not restore the leg. Prostheses and their training rules are on pp.160 and 174.',
    ],
    [
      'The arm is lost or permanently unusable. Bleeding begins.',
      'The arm remains unusable. Wound-induced bleeding ends.',
      'The arm can be replaced with a prosthesis. It remains unusable without one.',
      'Permanent consequence: the arm remains missing or unusable unless a prosthesis changes what it can do.',
      'Core p.174 gives no healing duration for Deadly wounds. A healed label does not restore the arm. Prostheses and their training rules are on pp.160 and 174.',
    ],
    [
      'Stamina is quartered. INT, WILL, REF, and DEX −3. Poison begins: 3 damage per round, ignoring armor.',
      'Stamina is halved. INT, WILL, REF, and DEX −1. Poison caused by this wound ends.',
      'Stamina −5 permanently.',
      'Permanent consequence: Stamina −5 remains.',
      'Core p.174 gives no healing duration for Deadly wounds. Completing treatment or marking this wound healed does not remove the permanent Stamina penalty.',
    ],
    [
      'Make an immediate Death save. If the character survives, Stamina, SPD, and BODY are quartered and bleeding begins.',
      'Stamina, SPD, and BODY are halved. Wound-induced bleeding ends.',
      'Whenever the character is bleeding, bleeding damage increases by 2 per round, permanently.',
      'Permanent consequence: whenever the character is bleeding, bleeding damage increases by 2 per round.',
      'The initial Death save occurs once when the injury is acquired. The permanent penalty does not cause bleeding on its own; it increases damage while bleeding. This follows the p.160 correction in Core Errata 2022. Core p.174 gives no healing duration for Deadly wounds.',
    ],
    [
      'Sight-based Awareness −5; DEX −4. Bleeding begins.',
      'Sight-based Awareness −3; DEX −2. Wound-induced bleeding ends.',
      'Sight-based Awareness and DEX −1 permanently.',
      'Permanent consequence: sight-based Awareness and DEX −1 remain.',
      'Apply the Awareness penalty only to checks that use sight. Core p.174 gives no healing duration for Deadly wounds; the permanent penalties remain after treatment or a healed label.',
    ],
    [
      'The character dies immediately.',
      'This fatal injury cannot be stabilized.',
      'This fatal injury cannot be treated.',
      'This fatal injury cannot heal. Changing its record does not revive the character.',
      'No stabilization, medical treatment, magical treatment, or recovery clock is available for this fatal injury.',
    ],
  ],
};

const severityOrder = ['simple', 'complex', 'difficult', 'deadly'];
const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );

/** Metadata for a published critical, including legacy wounds without a stable key. */
export function woundInfo(wound = {}) {
  let severity;
  let index;
  const keyed = /^(simple|complex|difficult|deadly)-([0-5])$/.exec(wound.key ?? '');
  if (keyed) {
    severity = keyed[1];
    index = Number(keyed[2]);
  } else {
    severity = wound.severity;
    index = WOUNDS[severity]?.findIndex((entry) => entry.name === wound.name) ?? -1;
    if (index < 0) return null;
  }
  const row = descriptions[severity][index];
  return {
    key: `${severity}-${index}`,
    severity,
    group: anatomy[index],
    page:
      severity === 'simple'
        ? 158
        : severity === 'complex'
          ? 159
          : severity === 'deadly' || index < 2
            ? 160
            : 159,
    stages: {
      untreated: row[0],
      stabilized: row[1],
      treated: row[2],
      healed: row[3] ?? noPenalty,
    },
    note: row[4] ?? '',
  };
}

/** Shared source for a runtime injury and its unassigned compendium template. */
export function woundItemData(wound = {}) {
  const info = woundInfo(wound);
  if (!info) throw new RangeError('Unknown published critical wound.');
  const index = Number(info.key.split('-')[1]);
  const canonical = WOUNDS[info.severity][index];
  const state = {
    ...structuredClone(canonical),
    ...structuredClone(wound),
    key: info.key,
    severity: info.severity,
    group: info.group,
    treatment: wound.treatment ?? 'untreated',
    location: wound.location ?? '',
    separateConditions: wound.separateConditions ?? true,
  };
  const level = severityOrder.indexOf(info.severity);
  const medicalDC = 12 + level * 2;
  const rounds = 2 + level * 2;
  const magicDC = 14 + level * 2;
  const magicUses = 4 + level * 2;
  const care = canonical.fatal
    ? 'Fatal injury: stabilization, treatment, and healing are unavailable.'
    : `Stabilize with one First Aid check at DC ${medicalDC}; Healing Hands can perform First Aid tasks. Medical treatment takes ${rounds} rounds followed by one Healing Hands check at DC ${medicalDC}. Magical treatment requires ${magicUses} successful healing-spell uses at Spell Casting DC ${magicDC}; these uses do not restore HP.`;
  const recovery = canonical.fatal
    ? 'No recovery clock applies.'
    : info.severity === 'deadly'
      ? 'The book gives no recovery duration for Deadly wounds. Permanent consequences remain after treatment or a healed label.'
      : 'Stabilization does not start healing. After medical or magical treatment, use BODY and severity in the Critical Healing table (p.174) for the recovery time. Temporary treated penalties end when that recovery is complete.';
  const labels = {
    untreated: 'Untreated',
    stabilized: 'Stabilized',
    treated: 'Treated',
    healed: 'Healed',
  };
  const description = [
    `<p><strong>${escapeHTML(canonical.name)}</strong> — ${escapeHTML(info.severity)} critical injury; ${escapeHTML(info.group)}.</p>`,
    ...Object.entries(info.stages).map(
      ([stage, text]) => `<p><strong>${labels[stage]}:</strong> ${escapeHTML(text)}</p>`
    ),
    `<p><strong>Care:</strong> ${escapeHTML(care)}</p>`,
    `<p><strong>Recovery:</strong> ${escapeHTML(recovery)}</p>`,
    ...(!canonical.fatal
      ? [
          '<p>Record successful magical treatment manually. Spellcasting and its resource costs are not automated by this wound card.</p>',
        ]
      : []),
    ...(info.note ? [`<p>${escapeHTML(info.note)}</p>`] : []),
    `<p>Source: The Witcher Core Rulebook v1.35, p.${info.page}; stabilization p.162; treatment and recovery pp.173–174. Core Errata 2022 applies.</p>`,
  ].join('\n');
  return {
    name: canonical.name,
    type: 'wound',
    img: 'icons/svg/blood.svg',
    system: {
      wound: state,
      source: 'The Witcher Core Rulebook v1.35',
      page: info.page,
      description,
      effectText: Object.entries(info.stages)
        .map(([stage, text]) => `${labels[stage]}: ${text}`)
        .join('\n'),
      quantity: 1,
      weight: 0,
      cost: 0,
      equipped: false,
      carried: false,
    },
  };
}
