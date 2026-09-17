import { magicChoiceFields, readMagicChoices } from './magic-choices.js';
import { magicTargetingProfile, validateMagicTargetCount } from './magic-targeting.js';
import { supportsRitualRuntime } from './magic-ritual-effects.js';
import { SYSTEM_ID } from './config.js';
import { RuleError, hitLocations } from './rules.js';
import { magicInfo } from './magic-catalog.js';
import { magicDefenses, validateMagicPower } from './magic-rules.js';
import {
  IMPLEMENTED_MAGIC,
  MAGIC_TRADITIONS,
  magicTradition,
  magicVigor,
  magicFocus,
  magicEffectLabel,
} from './magic-state.js';
import {
  input,
  manualCheckInput,
  woundArmInput,
  validateManualCheck,
  turnIdentity,
  escapeHTML as e,
  errorNotice,
} from './runtime.js';

const list = (collection) => collection?.contents ?? Array.from(collection ?? []);
const itemRows = (actor) =>
  list(actor?.items).map((item) => ({
    id: item.id ?? item._id,
    name: item.name,
    type: item.type,
    flags: item.flags,
    ...(item.system?.toObject?.() ?? item.system ?? item),
  }));
const title = (text) =>
  String(text ?? '')
    .replace(/[-_]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
const worldTime = () => Number(globalThis.game?.time?.worldTime ?? 0);
const currentRound = (combat = globalThis.game?.combat) =>
  combat?.started ? `${combat.id}:${combat.round}` : '';
const tokenDocument = (token) => token?.document ?? token;
const owned = (actor) => {
  if (!actor?.isOwner) throw new RuleError('You must own this actor.');
  return actor;
};

function costLabel(cost = {}) {
  if (cost.text) return cost.text;
  if (cost.options?.length) return `${cost.options.join(' / ')} STA`;
  return cost.min === cost.max ? `${cost.min ?? '?'} STA` : `${cost.min ?? '?'}–${cost.max ?? '?'} STA`;
}

/** Safe text view data; templates escape every book, actor, and Item string. */
export function magicItemDisplay(item, { actor = item.actor } = {}) {
  const system = item.system ?? item,
    entry = magicInfo(system.magic?.key),
    magic = entry ?? system.magic ?? {};
  const implemented =
      !!entry &&
      (IMPLEMENTED_MAGIC.has(entry.key) ||
        (entry.kind === 'ritual' && supportsRitualRuntime(entry.key)) ||
        entry.kind === 'hex'),
    counter = magic.key === 'dispel';
  return {
    id: item.id ?? item._id,
    name: item.name ?? entry?.name ?? 'Magic',
    img: item.img,
    key: magic.key ?? '',
    kind: title(magic.kind),
    tier: title(magic.tier),
    element: magic.element === 'unspecified' ? 'Element not specified in the book' : title(magic.element),
    known: !!entry,
    implemented,
    reference: !implemented,
    counter,
    owned: !!actor,
    canCast: implemented && !counter && !!actor?.isOwner,
    canRemove: !!actor?.isOwner,
    status: implemented
      ? counter
        ? 'Counter magic'
        : 'Casting supported'
      : 'Reference — effect not automated',
    costLabel: costLabel(magic.cost),
    rangeLabel: magic.range?.text ?? 'As described',
    durationLabel: magic.duration?.text ?? 'As described',
    defenseLabel: magic.defenses?.length
      ? magic.defenses
          .map(
            (key) =>
              ({
                dodge: 'Dodge/Escape or Athletics',
                block: 'Block',
                resistMagic: 'Resist Magic',
                spellCasting: 'Spell Casting',
              })[key] ?? title(key)
          )
          .join(' / ')
      : 'None; Dispel or Heliotrope may counter',
    source: item.system?.source ?? entry?.source ?? '',
    page: item.system?.page ?? entry?.page ?? '',
    text: entry?.text ?? system.effectText ?? '',
    hint: !implemented
      ? 'This entry preserves the book reference. It has no completed casting procedure yet.'
      : counter
        ? 'Use Dispel / Heliotrope on a casting card, or Dispel on an active magical effect.'
        : actor
          ? 'Cast to choose power and focus, review targets, and confirm the cost.'
          : 'Drag this Item onto a character or NPC to add it to their learned magic.',
  };
}

/** Actor tab model. Passing time/combat explicitly also makes previews deterministic. */
export function magicActorDisplay(
  actor,
  { time = worldTime(), combat = globalThis.game?.combat, isGM = globalThis.game?.user?.isGM ?? false } = {}
) {
  const state = actor.system ?? actor,
    tradition = magicTradition(state),
    round = currentRound(combat);
  const spent = round && state.magic?.roundKey === round ? Number(state.magic.spent || 0) : 0;
  const vigor = magicVigor(state),
    rows = itemRows(actor);
  const focuses = rows
    .filter((item) => {
      try {
        return magicFocus(state, rows, item.id) > 0;
      } catch {
        return false;
      }
    })
    .map((item) => ({ id: item.id, name: item.name, value: Number(item.properties.focus) }));
  const all = list(actor.items)
    .filter((item) => item.type === 'magic')
    .map((item) => magicItemDisplay(item, { actor }));
  const effects = (state.effects ?? [])
    .filter((effect) => effect.magic)
    .map((effect) => {
      const magic = effect.magic,
        casterEffect = !!magic.casterEffect;
      const remaining = effect.expires > 0 ? Math.max(0, effect.expires - time) : null;
      const canAct = !!actor.isOwner;
      return {
        id: effect.id,
        key: magic.key,
        name: effect.key || magicEffectLabel(magic.key),
        notes: effect.notes ?? '',
        power: magic.power,
        shieldHP: effect.shieldHP,
        hasShield: Number.isFinite(effect.shieldHP),
        maintenanceUnit: magic.maintenanceIntervalSeconds === 60 ? 'minute' : 'round',
        sourceUuid: magic.casterUuid ?? magic.sourceUuid,
        maintenance:
          magic.maintenance === 'half'
            ? magic.staCost / 2
            : magic.maintenance === 'initial'
              ? magic.staCost
              : magic.maintenance === 'fixed'
                ? Number(magicInfo(magic.key)?.duration.maintenanceCost || 0)
                : 0,
        durationLabel:
          remaining === null
            ? 'Until ended or its recovery condition is met'
            : remaining === 0
              ? 'Duration reached; awaiting effect update'
              : remaining >= 3600
                ? `${Math.ceil(remaining / 60)} minutes remaining`
                : `${Math.ceil(remaining)} seconds remaining`,
        canMaintain: canAct && casterEffect && ['initial', 'half', 'fixed'].includes(magic.maintenance),
        canEnd: canAct && (casterEffect || isGM),
        canResist: canAct && ['axii', 'puppet'].includes(magic.key),
        canWake: magic.key === 'somne' && canAct,
        canRecoverIllness:
          canAct && magic.key === 'cursed-illness' && !!magic.ongoing?.managed && !magic.suppressed,
        canTrap: canAct && casterEffect && magic.key === 'magic-trap' && !!magic.regionUuid,
        canDispel: canAct && !!magic.messageUuid,
        canCollapse: canAct && isGM && !!magic.pendingCollapse,
        canFall: canAct && isGM && !!magic.pendingFall,
        canProtect: canAct && casterEffect && magic.key === 'active-shield' && effect.shieldHP > 0,
        canManageHex: canAct && magic.kind === 'hex',
        canHexEvent:
          isGM &&
          magic.kind === 'hex' &&
          [
            'the-hex-of-shadows',
            'the-pestas-kiss',
            'the-hex-of-the-beast',
            'curse-of-temperance',
            'hex-of-forgetfulness',
          ].includes(magic.key),
        regionUuid: magic.regionUuid ?? '',
      };
    });
  return {
    tradition,
    traditions: Object.entries(MAGIC_TRADITIONS).map(([key, label]) => ({
      key,
      label,
      selected: key === tradition,
      selectedAttribute: key === tradition ? 'selected' : '',
    })),
    vigor,
    baseVigor: Number(state.vigor || 0),
    spent,
    remainingVigor: Math.max(0, vigor - spent),
    sta: state.sta?.value ?? 0,
    staMax: state.sta?.max ?? 0,
    inCombat: !!combat?.started,
    speech: state.magic?.speech !== false,
    gestures: state.magic?.gestures !== false,
    minorGestures: state.magic?.minorGestures !== false,
    heliotrope: Number(state.professionRanks?.heliotrope || 0),
    dimeritiumContact: !!state.magic?.dimeritiumContact,
    dimeritiumUnits: Number(state.magic?.dimeritiumUnits || 0),
    coneAngle: state.magic?.coneAngle ?? 90,
    focuses,
    known: all.filter((entry) => entry.implemented),
    references: all.filter((entry) => entry.reference),
    effects,
    canEdit: !!actor.isOwner,
    preparationHint: !tradition
      ? 'Choose a magical tradition before casting.'
      : vigor <= 0
        ? 'No Vigor is available. Check dimeritium and active effects.'
        : '',
  };
}

/** Runtime/model imports are deferred so rendering these views requires no Foundry globals. */
async function services(options = {}) {
  if (options.services) return options.services;
  const [runtime, magic, regions, authority] = await Promise.all([
    import('./runtime.js'),
    import('./magic-runtime.js'),
    import('./magic-regions.js'),
    import('./authority.js'),
  ]);
  return {
    ...runtime,
    ...magic,
    ...regions,
    runCommand: authority.runCommand,
    resolve: (uuid) => foundry.utils.fromUuid(uuid),
  };
}

async function chooseCasterToken(actor, api, providedUuid) {
  if (providedUuid) {
    const token = tokenDocument(await api.resolve(providedUuid));
    if (token?.actor?.uuid !== actor.uuid)
      throw new RuleError('The selected token does not belong to this caster.');
    return token;
  }
  const scene = globalThis.canvas?.scene;
  const controlled = list(globalThis.canvas?.tokens?.controlled)
    .map(tokenDocument)
    .filter((token) => token.actor?.uuid === actor.uuid);
  const active = list(actor.getActiveTokens?.(true, true) ?? [])
    .map(tokenDocument)
    .filter((token) => token.parent?.id === scene?.id);
  const candidates = [
    ...new Map((controlled.length ? controlled : active).map((token) => [token.uuid, token])).values(),
  ];
  if (actor.token?.parent?.id === scene?.id && !candidates.some((token) => token.uuid === actor.token.uuid))
    candidates.push(actor.token);
  if (!candidates.length)
    throw new RuleError('Place and select this actor’s token on the viewed scene before casting.');
  if (candidates.length === 1) return candidates[0];
  const answer = await api.prompt(
    'Choose casting token',
    input('tokenUuid', 'Caster token', {
      options: Object.fromEntries(candidates.map((token) => [token.uuid, `${token.name} (${token.id})`])),
    }),
    { button: 'Choose token' }
  );
  return answer ? candidates.find((token) => token.uuid === answer.tokenUuid) : null;
}

async function chooseTarget(api, source, providedUuids) {
  const selected = providedUuids
    ? await Promise.all(providedUuids.map((uuid) => api.resolve(uuid)))
    : list(globalThis.game?.user?.targets).map(tokenDocument);
  if (selected.length > 1) throw new RuleError('This magic needs one target. Select exactly one token.');
  if (selected.length === 1) {
    const target = tokenDocument(selected[0]);
    if (!target?.actor) throw new RuleError('The selected target token no longer exists.');
    return target;
  }
  const candidates = list(source.parent?.tokens).filter(
    (token) => token.actor && (!token.hidden || globalThis.game?.user?.isGM)
  );
  if (!candidates.length) throw new RuleError('There are no visible target tokens on this scene.');
  const result = await api.prompt(
    'Choose magic target',
    input('targetUuid', 'Target', {
      options: Object.fromEntries(candidates.map((token) => [token.uuid, `${token.name} (${token.id})`])),
    }),
    { button: 'Choose target' }
  );
  return result ? candidates.find((token) => token.uuid === result.targetUuid) : null;
}

function rollFields(actor, { arm = true } = {}) {
  return (
    input('modifier', 'Circumstance modifier', { value: 0 }) +
    input('luck', 'Luck to spend', { value: 0, min: 0, max: actor.system.luck?.value ?? 0 }) +
    (arm ? woundArmInput(actor) : '') +
    manualCheckInput()
  );
}
function elementField(magic) {
  return magic.element === 'unspecified'
    ? input('element', 'Element ruling if a backlash occurs (optional)', {
        options: {
          '': 'GM resolves only if needed',
          earth: 'Earth',
          air: 'Air',
          fire: 'Fire',
          water: 'Water',
          mixed: 'Mixed',
        },
      }) + '<p class="notes">The book does not specify an element for this magic.</p>'
    : '';
}
function focusField(actor) {
  const focuses = magicActorDisplay(actor).focuses;
  return input('focusId', 'Held focus — choose one', {
    options: {
      '': 'None',
      ...Object.fromEntries(focuses.map((focus) => [focus.id, `${focus.name} · Focus (${focus.value})`])),
    },
  });
}
function powerField(magic, value) {
  const cost = magic.cost;
  return input(
    'power',
    'Power before focus discount',
    cost.options?.length
      ? {
          value: value ?? cost.options[0],
          options: Object.fromEntries(cost.options.map((power) => [power, `${power} STA power`])),
        }
      : { value: value ?? cost.min, min: cost.min, max: cost.max, step: cost.step ?? 1 }
  );
}
function validateRoll(values, actor) {
  validateManualCheck(values, actor);
  for (const key of ['modifier', 'luck'])
    if (!Number.isFinite(Number(values[key] ?? 0)))
      throw new RuleError(`${title(key)} must be a finite number.`);
}
function targetSummary(targets) {
  return targets.length
    ? `<ul>${targets.map((target) => `<li>${e(target.name)}</li>`).join('')}</ul>`
    : '<p>No immediate target: the effect is placed or applied to the caster.</p>';
}

export async function castMagic(actor, item, options = {}) {
  owned(actor);
  if (['ritual', 'hex'].includes(magicInfo(item?.system.magic?.key)?.kind)) {
    const { castProcedure } = await import('./magic-procedures.js');
    return castProcedure(actor, item);
  }
  const api = await services(options),
    learned = api.learnedMagic(actor, item.id),
    magic = learned.magic;
  if (magic.key === 'dispel')
    throw new RuleError(
      'Use Dispel / Heliotrope on the casting card, or Dispel on an active magical effect.'
    );
  const initialTurn = turnIdentity(),
    expected = api.magicFingerprint(item);
  const source = await chooseCasterToken(actor, api, options.tokenUuid);
  if (!source) return null;
  const initialProfile = ['spell', 'invocation'].includes(magic.kind)
    ? magicTargetingProfile(magic, {
        choices: { coneAngle: actor.system.magic.coneAngle },
        spellCastingRank: actor.system.skills.spellCasting,
      })
    : null;
  const chooseAfterOptions =
    initialProfile?.requiredChoices.length || initialProfile?.targetMode === 'actors';
  const direct = initialProfile
    ? !chooseAfterOptions &&
      ['actor', 'object'].includes(initialProfile.targetMode) &&
      magic.key !== 'codi-bywyd'
    : magic.range.targeting === 'direct' && magic.key !== 'supirre';
  const target = direct ? await chooseTarget(api, source, options.targetUuids) : null;
  if (direct && !target) return null;
  let content =
    `<p>${e(item.name)} · ${e(magic.range.text)} · ${e(magic.duration.text)}</p>` +
    (options.leyJob?.type === 'repeatSpell'
      ? `<p>Mandatory Fire recast: original power ${e(options.power)}, original spell STA plus 3 STA for the forced action.</p>`
      : powerField(magic, options.power)) +
    (options.leyJob
      ? '<p>The Ley consequence determines the actual cost. Other focuses do not change this payment.</p>'
      : learned.amulet
        ? '<p>Stored amulet spell: only its Focus 2 applies. The wearer must have sufficient Vigor; overdraw is unavailable.</p>'
        : focusField(actor));
  if (magic.key === 'fire-stream' && target)
    content += input('aimed', 'Body location', {
      options: {
        '': 'Random location',
        ...Object.fromEntries(
          hitLocations(target.actor.system).map((location) => [
            location.id,
            `${location.label} (${location.aim})`,
          ])
        ),
      },
    });
  if (magic.key === 'igni')
    content +=
      '<p class="notes">Igni normally hits the torso. A single point-blank target can be aimed at during the final review.</p>';
  if (magic.key === 'magic-healing' && target)
    content +=
      input('healingWoundId', 'Healing mode', {
        options: {
          '': 'Restore Health Points',
          ...Object.fromEntries(
            list(target.actor.items)
              .filter(
                (wound) =>
                  wound.type === 'wound' &&
                  !wound.system.wound.fatal &&
                  ['untreated', 'stabilized'].includes(wound.system.wound.treatment)
              )
              .map((wound) => [wound.id, `Treat critical injury: ${wound.name}`])
          ),
        },
      }) + '<p class="notes">Critical-injury treatment counts successful uses instead of restoring HP.</p>';
  content +=
    magicChoiceFields(magic, actor, target?.actor) +
    elementField(magic) +
    (options.leyJob?.type === 'replaceSpell'
      ? '<p>Uses the original casting check and always goes off despite its fumble; targets still receive their printed defenses.</p>'
      : rollFields(actor));
  if (!options.reactionId && !options.leyJob)
    content +=
      input('extra', 'Use extra action (3 STA, −3 check)', { type: 'checkbox' }) +
      input('forfeit', 'Forfeit remaining strikes', { type: 'checkbox' });
  else if (options.reactionId)
    content += '<p>School armor reaction: only this Sign’s STA cost is charged.</p>';
  const values = await api.prompt(`Cast ${item.name}`, content, {
    button: 'Place area / review',
    validate: (answer) => {
      validateMagicPower(
        magic,
        Number(options.leyJob?.type === 'repeatSpell' ? options.power : answer.power)
      );
      validateRoll(answer, actor);
    },
  });
  if (!values) return null;
  values.power = Number(options.leyJob?.type === 'repeatSpell' ? options.power : values.power);
  values.choices = readMagicChoices(magic, values);
  if (options.reactionId) values.reactionId = options.reactionId;
  const profile = initialProfile
    ? magicTargetingProfile(magic, {
        choices: { coneAngle: actor.system.magic.coneAngle, ...values.choices },
        spellCastingRank: actor.system.skills.spellCasting,
      })
    : null;
  let selected = target ? [target] : [];
  if (chooseAfterOptions && ['actor', 'actors'].includes(profile?.targetMode)) {
    selected = options.targetUuids
      ? await Promise.all(options.targetUuids.map((uuid) => api.resolve(uuid)))
      : list(globalThis.game?.user?.targets).map(tokenDocument);
    if (!selected.length) {
      const chosen = await chooseTarget(api, source);
      if (!chosen) return null;
      selected = [chosen];
    }
    validateMagicTargetCount(profile, selected);
  }
  const spec = api.magicAreaSpec(actor, magic, values.power, values.choices);
  const area = spec ? await api.previewMagicRegion({ casterToken: source, spec, name: item.name }) : null;
  if (spec && !area) return null;
  const targets = area
    ? spec.pointOnly
      ? []
      : area.candidates.filter((candidate) => candidate.included)
    : selected.map((token) => ({ name: token.name, tokenUuid: token.uuid, tokenId: token.id }));
  const plan = api.actionPlan(actor, {
    full: magic.key === 'magic-trap',
    extra: !!values.extra,
    forfeit: !!values.forfeit,
    reaction: !!options.reactionId,
    expectedTurn: initialTurn,
  });
  const { cost } = api.magicSpending(
    actor,
    magic,
    values.power,
    { ...values, amuletId: learned.amulet?.id || '', overdraw: true },
    plan
  );
  let summary = `<p><strong>${e(item.name)}</strong> · power ${e(cost.power)} · ${e(cost.staCost)} STA</p><p>Magic this round: ${e(cost.roundBefore)} → ${e(cost.roundAfter)} / Vigor ${e(cost.vigor)}. STA after the action: ${e(cost.staAfter)}.</p>`;
  if (plan.cost) summary += `<p>Action surcharge: ${e(plan.cost)} STA, included above.</p>`;
  summary += '<h4>Targets / area occupants</h4>' + targetSummary(targets);
  if (area?.warnings?.length)
    summary += area.warnings.map((warning) => `<p class="notes">${e(warning)}</p>`).join('');
  if (spec?.angleSource === 'table')
    summary += `<p class="notes">Cone angle: ${e(spec.angle)}°, the configured table convention.</p>`;
  if (spec)
    summary +=
      '<p class="notes">The active GM checks the area again when casting, including unseen tokens. Each target still resolves its permitted defense.</p>';
  if (magic.key === 'igni' && targets.length === 1) {
    const aimedTarget = target ?? source.parent.tokens.get(targets[0].tokenId);
    if (aimedTarget?.actor && api.magicTokenDistance(source, aimedTarget) <= 0.001)
      summary += input('aimed', 'Point-blank location', {
        options: {
          '': 'Torso (normal Igni)',
          ...Object.fromEntries(
            hitLocations(aimedTarget.actor.system).map((location) => [
              location.id,
              `${location.label} (${location.aim})`,
            ])
          ),
        },
      });
  }
  if (cost.hpCost)
    summary +=
      `<p><strong>Overexertion costs ${e(cost.hpCost)} HP and causes an elemental backlash.</strong></p>` +
      input('overdraw', `Accept ${cost.hpCost} HP loss and elemental backlash`, { type: 'checkbox' });
  if (cost.exhausted) summary += '<p><strong>This cast uses the last STA and causes exhaustion.</strong></p>';
  const confirmation = await api.prompt(`Confirm ${item.name}`, summary, {
    button: 'Cast',
    validate: (answer) => {
      if (cost.hpCost && !answer.overdraw)
        throw new RuleError('Explicitly accept the displayed overexertion cost, or cancel.');
    },
  });
  if (!confirmation) return null;
  return api.runCommand(
    'magicCast',
    {
      actorUuid: actor.uuid,
      itemId: item.id,
      expected,
      turn: initialTurn,
      tokenUuid: source.uuid,
      targetUuids: selected.map((token) => token.uuid),
      area,
      values: { ...values, ...confirmation },
    },
    { label: `Cast ${item.name}` }
  );
}

export async function defendMagic(message, targetUuid, options = {}) {
  const api = await services(options),
    data = message.flags?.[SYSTEM_ID],
    row = data?.targets?.find((target) => target.tokenUuid === targetUuid);
  if (!row) throw new RuleError('This target is not on the casting card.');
  const actor = owned(await api.actorFromUuid(row.actorUuid)),
    turn = turnIdentity();
  const allowed = magicDefenses(data.magic, { includeCounters: false });
  const labels = {
    dodge: 'Dodge/Escape',
    athletics: 'Reposition (Athletics)',
    block: 'Block with equipment',
    resistMagic: 'Resist Magic',
    passive: 'Passive DC (stunned, unconscious, unaware)',
    accept: 'Accept the magic / no defense',
  };
  const weapons = list(actor.items).filter(
    (item) => ['weapon', 'shield'].includes(item.type) && item.system.equipped && item.system.reliability > 0
  );
  const defenses = allowed.filter((key) => key !== 'block' || weapons.length);
  if (
    allowed.some((key) => ['dodge', 'athletics', 'block'].includes(key)) &&
    (globalThis.game?.user?.isGM ||
      actor.system.conditions.some((c) => ['stunned', 'unconscious'].includes(c)))
  )
    defenses.push('passive');
  let content =
    `<p>${e(data.name)} · casting total ${e(data.check.total)}</p>` +
    input('defense', 'Defense', {
      options: Object.fromEntries([...defenses, 'accept'].map((key) => [key, labels[key] ?? title(key)])),
    });
  if (defenses.includes('block'))
    content += input('weaponId', 'Blocking equipment', {
      options: Object.fromEntries(
        weapons.map((weapon) => [weapon.id, `${weapon.name} · REL ${weapon.system.reliability}`])
      ),
    });
  if (defenses.includes('passive'))
    content += input('dc', 'Passive DC (stunned/unconscious always 10)', { value: 10, min: 0 });
  content += rollFields(actor);
  const values = await api.prompt(`Defend against ${data.name}`, content, {
    button: 'Resolve defense',
    validate: (values) => validateRoll(values, actor),
  });
  if (!values) return null;
  return api.runCommand(
    'magicDefense',
    { messageUuid: message.uuid, targetUuid, turn, values },
    { label: `Defend against ${data.name}` }
  );
}

async function chooseReactor(api, message) {
  const controlled = list(globalThis.canvas?.tokens?.controlled)
    .map(tokenDocument)
    .filter((token) => token.actor?.isOwner);
  if (!controlled.length) throw new RuleError('Select an owned reacting character’s token.');
  if (controlled.length === 1) return controlled[0];
  const answer = await api.prompt(
    `Counter ${message.flags?.[SYSTEM_ID]?.name ?? 'magic'}`,
    input('tokenUuid', 'Reacting token', {
      options: Object.fromEntries(controlled.map((token) => [token.uuid, `${token.name} (${token.id})`])),
    }),
    { button: 'Choose reactor' }
  );
  return answer ? controlled.find((token) => token.uuid === answer.tokenUuid) : null;
}

export async function counterMagic(message, options = {}) {
  const initialTurn = turnIdentity();
  const api = await services(options),
    data = message.flags?.[SYSTEM_ID],
    token = await chooseReactor(api, message);
  if (!token) return null;
  const actor = token.actor,
    choices = {};
  const dispels = list(actor.items)
    .filter((item) => item.type === 'magic' && item.system.magic?.key === 'dispel')
    .filter((item) => {
      try {
        api.learnedMagic(actor, item.id);
        return true;
      } catch {
        return false;
      }
    });
  if (dispels.length) choices.dispel = 'Dispel (must beat casting total)';
  if (
    Number(actor.system.professionRanks?.heliotrope) > 0 ||
    actor.system.customSkills?.some((skill) => skill.id === 'heliotrope' && skill.rank > 0)
  )
    choices.heliotrope = 'Heliotrope (may tie casting total)';
  if (!Object.keys(choices).length)
    throw new RuleError('This actor has neither learned Dispel nor trained Heliotrope.');
  const values = await api.prompt(
    `Counter ${data.name}`,
    `<p>Original casting: ${e(data.staCost)} STA, total ${e(data.check.total)}. Counter cost before a usable focus: ${e(data.staCost / 2)} STA.</p>` +
      input('defense', 'Counter', { options: choices }) +
      (dispels.length
        ? input('dispelItemId', 'Dispel source (amulet forces its Focus 2)', {
            options: Object.fromEntries(dispels.map((item) => [item.id, item.name])),
          })
        : '') +
      focusField(actor) +
      rollFields(actor) +
      elementField({ element: data.element === 'unspecified' ? 'unspecified' : 'mixed' }),
    { button: 'Review cost', validate: (values) => validateRoll(values, actor) }
  );
  if (!values) return null;
  const dispelSource = values.defense === 'dispel' ? api.learnedMagic(actor, values.dispelItemId) : null;
  const plan = api.actionPlan(actor, { defense: !data.applied || !!data.ongoingAttack });
  const { cost } = api.magicSpending(
    actor,
    values.defense === 'dispel' ? magicInfo('dispel') : { kind: 'sign', key: 'heliotrope' },
    data.staCost / 2,
    { ...values, counter: true, overdraw: true, amuletId: dispelSource?.amulet?.id || '' },
    plan
  );
  const confirmation = await api.prompt(
    'Confirm counter magic',
    `<p>${e(values.defense)}: ${e(cost.staCost)} STA. Round magic: ${e(cost.roundAfter)} / Vigor ${e(cost.vigor)}. STA after action: ${e(cost.staAfter)}.</p>` +
      (cost.hpCost
        ? `<p>Overexertion: ${e(cost.hpCost)} HP and an elemental consequence.</p>` +
          input('overdraw', 'Accept the displayed overexertion', { type: 'checkbox' })
        : ''),
    {
      button: 'Counter magic',
      validate: (answer) => {
        if (cost.hpCost && !answer.overdraw)
          throw new RuleError('Accept the displayed overexertion cost, or cancel.');
      },
    }
  );
  if (!confirmation) return null;
  return api.runCommand(
    'magicCounter',
    {
      messageUuid: message.uuid,
      reactorUuid: actor.uuid,
      tokenUuid: token.uuid,
      turn: initialTurn,
      values: { ...values, ...confirmation },
    },
    { label: `Counter ${data.name}` }
  );
}

export async function applyUIaction(actor, effect, action, options = {}) {
  if (action === 'hexEvent') {
    const { hexEventAction } = await import('./magic-hex-runtime.js');
    return hexEventAction(actor, effect);
  }
  if (action === 'manageHex') {
    const { manageHex } = await import('./magic-procedures.js');
    return manageHex(actor, effect.id);
  }
  owned(actor);
  const api = await services(options),
    base = { actorUuid: actor.uuid, effectId: effect.id },
    turn = turnIdentity();
  if (action === 'dispel') {
    const message = await api.resolve(effect.magic.messageUuid);
    if (!message) throw new RuleError('The original casting card is no longer available.');
    return counterMagic(message, options);
  }
  if (action === 'fall') {
    if (!globalThis.game?.user?.isGM) throw new RuleError('The GM establishes the actual fall height.');
    const values = await api.prompt(
      'Resolve magical knockdown',
      '<p>Enter the actual unobstructed distance to the landing surface. Use 0 if the target was standing on elevated terrain.</p>' +
        input('height', 'Metres fallen', { value: 0, min: 0 }),
      { button: 'Resolve fall' }
    );
    return values
      ? api.runCommand('magicFall', { ...base, values }, { label: 'Resolve magical fall' })
      : null;
  }
  if (action === 'collapse') {
    if (!globalThis.game?.user?.isGM) throw new RuleError('The GM resolves the shield collapse.');
    const source = await chooseCasterToken(actor, api, effect.magic.tokenUuid);
    if (!source) return null;
    const adjacent = list(source.parent.tokens).filter(
      (token) => token.actor && token.uuid !== source.uuid && api.magicTokenDistance(source, token) <= 0.001
    );
    const content =
      '<p>Adjacent creatures and objects take 1d6 torso damage, including allies. The burst pushes targets 2m unless rooted or heavier than 226kg. Mark only targets that cannot be pushed; their damage still applies.</p>' +
      adjacent
        .map((token) =>
          input(`anchored.${token.id}`, `${token.name}: rooted or over 226kg`, { type: 'checkbox' })
        )
        .join('');
    const answer = await api.prompt('Resolve Active Shield collapse', content, { button: 'Resolve burst' });
    if (!answer) return null;
    return api.runCommand(
      'magicCollapse',
      {
        ...base,
        values: {
          anchoredTokenUuids: adjacent
            .filter((token) => answer[`anchored.${token.id}`])
            .map((token) => token.uuid),
        },
      },
      { label: 'Active Shield collapse' }
    );
  }
  if (action === 'protect') {
    const source = await chooseCasterToken(actor, api, effect.magic.tokenUuid);
    if (!source) return null;
    const adjacent = list(source.parent.tokens).filter(
      (token) => token.actor && token.uuid !== source.uuid && api.magicTokenDistance(source, token) <= 0.001
    );
    const answer = await api.prompt(
      'Share Active Shield',
      '<p>One companion can share the shield while pressed against the caster. Both use the same shield HP.</p>' +
        input('targetUuid', 'Protected companion', {
          options: {
            '': 'No companion',
            ...Object.fromEntries(adjacent.map((token) => [token.uuid, token.name])),
          },
        }),
      { button: 'Update protection' }
    );
    return answer
      ? api.runCommand(
          'magicProtect',
          { ...base, targetUuid: answer.targetUuid },
          { label: 'Share Active Shield' }
        )
      : null;
  }
  if (action === 'end') {
    const answer = await api.prompt(
      'End magical effect',
      `<p>End ${e(effect.key)}?</p>${effect.magic?.key === 'active-shield' ? '<p>Active Shield releases its damage and push when dropped.</p>' : ''}`,
      { button: 'End effect' }
    );
    return answer ? api.runCommand('magicEnd', base, { label: `End ${effect.key}` }) : null;
  }
  if (action === 'maintain') {
    const magic = magicInfo(effect.magic.key),
      amount = effect.magic.maintenance === 'half' ? effect.magic.staCost / 2 : effect.magic.staCost;
    const stream = effect.magic.key === 'fire-stream';
    let values = {},
      target = null;
    if (stream) {
      const source = await chooseCasterToken(actor, api, effect.magic.tokenUuid);
      if (!source) return null;
      target = await chooseTarget(api, source);
      if (!target) return null;
      values = await api.prompt(
        'Maintain Fire Stream',
        `<p>Continue the stream against ${e(target.name)}.</p>` +
          input('aimed', 'Body location', {
            options: {
              '': 'Random location',
              ...Object.fromEntries(
                hitLocations(target.actor.system).map((location) => [
                  location.id,
                  `${location.label} (${location.aim})`,
                ])
              ),
            },
          }) +
          rollFields(actor) +
          input('extra', 'Use extra action (3 STA, −3 check)', { type: 'checkbox' }) +
          input('forfeit', 'Forfeit remaining strikes', { type: 'checkbox' }),
        { button: 'Review cost', validate: (values) => validateRoll(values, actor) }
      );
      if (!values) return null;
      values.targetUuid = target.uuid;
    }
    const plan = stream
      ? api.actionPlan(actor, { extra: !!values.extra, forfeit: !!values.forfeit, expectedTurn: turn })
      : { changes: {}, modifier: 0 };
    const { cost } = api.magicSpending(actor, magic, amount, { maintenance: true, overdraw: true }, plan);
    let content = `<p>Maintain ${e(effect.key)} for ${e(cost.staCost)} STA. Round magic: ${e(cost.roundAfter)} / Vigor ${e(cost.vigor)}. STA remaining: ${e(cost.staAfter)}.</p>`;
    if (cost.hpCost)
      content +=
        `<p>Overexertion: ${e(cost.hpCost)} HP and an elemental consequence.</p>` +
        input('overdraw', 'Accept the displayed overexertion', { type: 'checkbox' });
    if (stream) content += targetSummary([target]);
    const confirmation = await api.prompt(`Confirm ${effect.key} upkeep`, content, {
      button: 'Maintain',
      validate: (answer) => {
        if (cost.hpCost && !answer.overdraw)
          throw new RuleError('Accept the displayed overexertion cost, or cancel.');
      },
    });
    if (!confirmation) return null;
    return api.runCommand(
      'magicMaintain',
      { ...base, values: { ...values, ...confirmation }, turn },
      { label: `Maintain ${effect.key}` }
    );
  }
  if (action === 'resist') {
    const content =
      effect.magic.key === 'axii'
        ? `<p>Recover from Axii with a Stun save (${e(effect.magic.stunModifier ?? 0)}).</p>`
        : `<p>Resist ${e(effect.key)} against the original casting total ${e(effect.magic.castingTotal)}.</p>` +
          rollFields(actor, { arm: false });
    const values = await api.prompt(`Resist ${effect.key}`, content, {
      button: 'Attempt recovery',
      validate: (values) => validateRoll(values, actor),
    });
    return values
      ? api.runCommand('magicResist', { ...base, values }, { label: `Resist ${effect.key}` })
      : null;
  }
  if (action === 'wake') {
    const token = await chooseReactor(api, { flags: { [SYSTEM_ID]: { name: 'Somne' } } });
    if (!token) return null;
    const modes =
      effect.magic.wake === 'noise'
        ? {
            ...(globalThis.game?.user?.isGM ? { noise: 'Loud noise (GM)' } : {}),
            action: 'Wake with an action',
          }
        : effect.magic.wake === 'action'
          ? { action: 'Wake with an action' }
          : effect.magic.wake === 'fullRound'
            ? { fullRound: 'Wake with a full-round action' }
            : {};
    if (!Object.keys(modes).length)
      throw new RuleError('This strength of Somne ends only through damage or expiration.');
    const values = await api.prompt(
      'Wake a sleeping target',
      input('mode', 'Wake method', { options: modes }),
      { button: 'Wake target' }
    );
    return values
      ? api.runCommand(
          'magicWake',
          { actorUuid: token.actor.uuid, targetUuid: actor.uuid, effectId: effect.id, mode: values.mode },
          { label: 'Wake sleeping target' }
        )
      : null;
  }
  if (action === 'trap') throw new RuleError('Use the trap’s current ready-to-attack card in chat.');
  throw new RuleError('Unknown magical effect action.');
}

async function trapAttack(message, options = {}) {
  const api = await services(options),
    data = message.flags[SYSTEM_ID];
  const region = !data.casterUuid && !data.actorUuid ? await foundry.utils.fromUuid(data.regionUuid) : null;
  const actor = await api.actorFromUuid(
    data.casterUuid ?? data.actorUuid ?? region?.flags?.[SYSTEM_ID]?.magicArea?.casterUuid
  );
  let targetUuid = data.targetTokenUuid;
  if (data.needsGMTarget) {
    if (!globalThis.game?.user?.isGM) throw new RuleError('The GM must choose the trap’s nearest enemy.');
    const targets = list(globalThis.game.user.targets).map(tokenDocument);
    if (targets.length !== 1) throw new RuleError('The GM must target exactly one closest enemy.');
    targetUuid = targets[0].uuid;
  }
  const values = await api.prompt('Magic Trap attack', manualCheckInput(), {
    button: 'Attack nearest enemy',
    validate: (values) => validateManualCheck(values, actor),
  });
  return values
    ? api.runCommand(
        'magicTrapAttack',
        { messageUuid: message.uuid, targetUuid, values, turn: turnIdentity() },
        { label: 'Magic Trap attack' }
      )
    : null;
}

async function resolveBacklash(message, options = {}) {
  if (!globalThis.game?.user?.isGM) throw new RuleError('The GM resolves magical backlash.');
  const api = await services(options),
    data = message.flags[SYSTEM_ID];
  let content = '<p>Resolve any remaining elemental displacement or destroyed-focus explosion.</p>';
  if (data.backlash?.needsElement || data.needsElement || data.element === 'unspecified' || !data.element)
    content += input('element', 'Elemental consequence (GM ruling)', {
      options: { earth: 'Earth', air: 'Air', fire: 'Fire', water: 'Water' },
    });
  content += input('pushAngle', 'Air backlash push direction (degrees)', {
    value: 0,
    min: 0,
    max: 359,
    step: 1,
  });
  const values = await api.prompt('Resolve magical backlash', content, { button: 'Apply backlash' });
  return values
    ? api.runCommand(
        'magicBacklash',
        { messageUuid: message.uuid, values },
        { label: 'Resolve magic backlash' }
      )
    : null;
}

export function registerMagicChat() {
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const root = html[0] ?? html;
    for (const button of root.querySelectorAll('[data-magic-action]')) {
      const action = button.dataset.magicAction;
      if (['apply', 'backlash', 'collapse'].includes(action)) button.hidden = !game.user.isGM;
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        try {
          if (action === 'defend') await defendMagic(message, button.dataset.target);
          else if (action === 'counter') await counterMagic(message);
          else if (action === 'trap') await trapAttack(message);
          else if (action === 'backlash') await resolveBacklash(message);
          else if (['resist', 'collapse'].includes(action)) {
            const api = await services(),
              data = message.flags[SYSTEM_ID];
            const actor = await api.actorFromUuid(data.actorUuid),
              effect = actor?.system.effects.find(
                (row) => row.id === (button.dataset.effect ?? data.effectId)
              );
            if (!effect) throw new RuleError('This magical effect no longer exists.');
            await applyUIaction(actor, effect, action);
          } else if (action === 'apply') {
            const api = await services();
            await api.runCommand(
              'magicApply',
              { messageUuid: message.uuid, targetUuid: button.dataset.target },
              { label: 'Apply magic' }
            );
          }
        } catch (error) {
          errorNotice(error);
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
    }
  });
}
