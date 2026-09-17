import { SYSTEM_ID, STATS, SKILLS } from './config.js';
import { RuleError } from './rules.js';
import { MAGIC_CREATURE_PROFILES, magicCreatureProfile } from './magic-creature-profiles.js';

const clone = (value) => structuredClone(value);
const source = (document) =>
  document?.toObject ? document.toObject() : clone(document?._source ?? document);
const entries = (collection) =>
  collection?.contents ?? Array.from(collection?.values?.() ?? collection ?? []);
const pathValue = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const escaped = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]
  );
const actorOf = (target) => target?.actor ?? target?.document?.actor ?? target;
const castKey = (context) => {
  if (typeof context.castId !== 'string' || !context.castId)
    throw new RuleError('A world magic operation needs a saved cast ID.');
  return context.castId;
};
const flags = (context, operation, extra = {}) => ({
  [SYSTEM_ID]: {
    magicWorld: {
      castId: castKey(context),
      casterUuid: context.caster.uuid,
      key: context.sourceMagic?.key,
      operation: clone(operation),
      ...extra,
    },
  },
});
const itemActions = new Set([
  'property',
  'suppressFocus',
  'recordScar',
  'copyConsumable',
  'sacrifice',
  'createFood',
  'growPlant',
  'inscribe',
  'prepareMutagenExtraction',
  'createCover',
  'increaseCoverSP',
  'ablateCover',
  'rust',
  'purifyWater',
  'purifyIngots',
  'refreshFood',
  'forageYield',
  'fertileSoil',
  'transmute',
  'recoverAlchemySubstance',
]);
const actorProfiles = {
  golem: 'Golem',
  wraith: 'Wraith',
  cat: 'Cat',
  dog: 'Dog',
  bird: 'Bird',
  serpent: 'Serpent',
  horse: 'Horse',
  warhorse: 'War Horse',
  crow: 'Bird',
  'living-armor': 'Living Armor',
  'corpse-amalgam': 'Corpse Amalgam',
};
const immediateRevealFields = new Set(['hp', 'wounds', 'disease', 'poison']);

/** A capability answer never treats a stored prose flag as an executed procedure. */
export function worldOperationSupport(operation) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.type === 'narrative' || operation.type === 'reveal') return true;
  if (operation.type === 'item')
    return (
      itemActions.has(operation.action) &&
      !['purifyIngots', 'forageYield', 'fertileSoil'].includes(operation.action)
    );
  if (operation.type === 'summon')
    return (
      Object.hasOwn(actorProfiles, operation.profile) &&
      !operation.arrivalRounds &&
      !operation.appearsWithinSeconds
    );
  if (operation.type === 'transform') return ['serpent', 'cat', 'bird', 'dog'].includes(operation.form);
  if (operation.type === 'zone')
    return !operation.action && ['circle', 'cone', 'rectangle', 'line'].includes(operation.shape?.shape);
  return false;
}

export const WORLD_MAGIC_CAPABILITIES = Object.freeze({
  types: ['item', 'reveal', 'narrative', 'summon', 'transform', 'zone'],
  itemActions: [...itemActions],
  summonProfiles: Object.keys(actorProfiles),
  transformForms: ['serpent', 'cat', 'bird', 'dog'],
  pendingDecisionTypes: ['narrative', 'reveal'],
});

function authority(context) {
  const user = context.user ?? globalThis.game?.user;
  if (!user?.isGM) throw new RuleError('The active GM executes world magic effects.');
  if (!context.caster?.uuid) throw new RuleError('A caster actor is required.');
  castKey(context);
}

function transaction(context, operation) {
  const undo = [];
  const documents = [];
  return {
    undo,
    documents,
    async update(document, patch) {
      const before = source(document);
      const restore = {};
      for (const key of Object.keys(patch)) {
        const value = pathValue(before, key);
        if (value !== undefined) restore[key] = clone(value);
        else {
          const parts = key.split('.');
          parts[parts.length - 1] = '-=' + parts.at(-1);
          restore[parts.join('.')] = null;
        }
      }
      undo.push(() => document.update(restore, { witcherMagicRollback: true }));
      await document.update(patch);
      documents.push(document.uuid);
    },
    async created(document) {
      if (!document?.uuid || typeof document.delete !== 'function')
        throw new RuleError('Foundry did not create the magic document.');
      documents.push(document.uuid);
      undo.push(() => document.delete({ witcherMagicRollback: true }));
      return document;
    },
    async rollback() {
      const failures = [];
      for (const reverse of [...undo].reverse())
        try {
          await reverse();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length)
        throw new AggregateError(failures, 'Some magic document changes could not be rolled back.');
    },
    result(status, details = {}) {
      return {
        status,
        receipt: {
          type: operation.type,
          action: operation.action ?? operation.procedure,
          castId: context.castId,
          documentUuids: [...new Set(documents)],
          ...details,
        },
        rollback: () => this.rollback(),
      };
    },
  };
}

async function resolve(context, uuid) {
  if (!uuid) return null;
  for (const actor of [
    context.caster,
    actorOf(context.target),
    ...entries(context.targets).map(actorOf),
  ].filter(Boolean)) {
    if (actor.uuid === uuid || actor.id === uuid) return actor;
    const owned = actor.items?.get?.(uuid) ?? entries(actor.items).find((item) => item.uuid === uuid);
    if (owned) return owned;
  }
  return (context.resolveUuid ?? globalThis.foundry?.utils?.fromUuid ?? globalThis.fromUuid)?.(uuid) ?? null;
}
async function ownedItem(context, uuid) {
  const item = await resolve(context, uuid);
  if (!item || (item.documentName !== 'Item' && !item.system) || !item.parent || item.pack)
    throw new RuleError('Select an owned Item; compendium entries cannot be changed in place.');
  const allowed = [context.caster, actorOf(context.target), ...entries(context.targets).map(actorOf)].filter(
    Boolean
  );
  if (!allowed.some((actor) => actor.uuid === item.parent.uuid))
    throw new RuleError('The selected Item is outside this casting’s actor targets.');
  return item;
}
async function createItems(actor, data, tx) {
  const created = await actor.createEmbeddedDocuments('Item', data);
  for (const item of created) await tx.created(item);
  return created;
}
async function post(context, data, tx) {
  const create = context.postMessage ?? ((message) => globalThis.ChatMessage.create(message));
  return tx.created(await create(data));
}
function gmIds(context = {}) {
  return entries(context.users ?? globalThis.game?.users)
    .filter((user) => user.isGM)
    .map((user) => user.id);
}
function requesterIds(context) {
  const ids = new Set(gmIds(context));
  if (context.user?.isGM && context.user.id) ids.add(context.user.id);
  for (const user of entries(context.users ?? globalThis.game?.users))
    if (context.caster.testUserPermission?.(user, 'OWNER')) ids.add(user.id);
  for (const [id, level] of Object.entries(context.caster.ownership ?? {}))
    if (id !== 'default' && level >= 3) ids.add(id);
  return [...ids];
}
async function pendingDecision(operation, context, tx) {
  const metadata = {
    status: 'pendingGM',
    castId: context.castId,
    key: context.sourceMagic?.key,
    operation: clone(operation),
    casterUuid: context.caster.uuid,
    targetUuids: entries(context.targets)
      .map(actorOf)
      .filter(Boolean)
      .map((actor) => actor.uuid),
  };
  const title =
    operation.type === 'narrative' ? operation.procedure : (operation.fields?.join(', ') ?? 'Information');
  const body = `<section class="witcher-magic-decision"><h3>${escaped(context.sourceMagic?.name ?? context.sourceMagic?.key ?? 'Magic')}: GM decision</h3><p>${escaped(title)}</p><p>${escaped(context.sourceMagic?.text ?? '')}</p>${operation.question ? `<p><strong>Question:</strong> ${escaped(operation.question)}</p>` : ''}${operation.description ? `<p><strong>Requested effect:</strong> ${escaped(operation.description)}</p>` : ''}${operation.dc !== undefined ? `<p><strong>DC:</strong> ${escaped(operation.dc)}</p>` : ''}<p>Pending: enter the actual ruling or revealed information before resolving this effect.</p><button type="button" data-witcher-world-decision="resolve">Record GM ruling</button></section>`;
  const message = await post(
    context,
    { content: body, whisper: gmIds(context), flags: { [SYSTEM_ID]: { magicDecision: metadata } } },
    tx
  );
  return tx.result('pendingGM', { decisionMessageUuid: message.uuid, procedure: title });
}

/** GM decisions are persisted on their original message; they are not automatically called spell success. */
export async function resolveWorldMagicDecision(message, { outcome, answer }, context = {}) {
  if (!(context.user ?? globalThis.game?.user)?.isGM)
    throw new RuleError('Only a GM can resolve this magic decision.');
  const decision =
    message?.getFlag?.(SYSTEM_ID, 'magicDecision') ?? message?.flags?.[SYSTEM_ID]?.magicDecision;
  if (!['resolved', 'declined'].includes(outcome) || typeof answer !== 'string' || !answer.trim())
    throw new RuleError('Record the actual GM ruling or information.');
  if (decision?.status === outcome && decision.answer === answer.trim())
    return {
      status: outcome,
      castId: decision.castId,
      messageUuid: message.uuid,
      replyMessageUuid: decision.replyMessageUuid,
      duplicate: true,
    };
  if (!decision || decision.status !== 'pendingGM')
    throw new RuleError('This magic decision is no longer pending.');
  const tx = transaction(
    { ...context, castId: decision.castId },
    { type: 'narrative', procedure: 'resolveDecision' }
  );
  let reply;
  try {
    if (outcome === 'resolved') {
      const caster =
        context.caster ??
        (await (context.resolveUuid ?? globalThis.foundry?.utils?.fromUuid ?? globalThis.fromUuid)?.(
          decision.casterUuid
        ));
      if (!caster) throw new RuleError('The caster must be available to receive the revealed information.');
      // Reuse a reply created before an interrupted original-message update.
      reply = entries(context.messages ?? globalThis.game?.messages).find(
        (entry) => entry.flags?.[SYSTEM_ID]?.magicDecisionReply?.decisionMessageUuid === message.uuid
      );
      if (!reply)
        reply = await post(
          context,
          {
            content: `<h3>${escaped(context.sourceMagic?.name ?? decision.key ?? 'Magic')}: GM ruling</h3><p>${escaped(answer.trim())}</p>`,
            whisper: requesterIds({ ...context, caster }),
            flags: {
              [SYSTEM_ID]: {
                magicDecisionReply: {
                  decisionMessageUuid: message.uuid,
                  castId: decision.castId,
                  casterUuid: caster.uuid,
                  answer: answer.trim(),
                },
              },
            },
          },
          tx
        );
    }
    await tx.update(message, {
      [`flags.${SYSTEM_ID}.magicDecision`]: {
        ...decision,
        status: outcome,
        answer: answer.trim(),
        resolvedBy: (context.user ?? game.user).id,
        replyMessageUuid: reply?.uuid ?? '',
      },
      content: `${message.content.replace(/<button[^>]*data-witcher-world-decision[^>]*>.*?<\/button>/g, '')}<p><strong>${escaped(outcome)}:</strong> ${escaped(answer.trim())}</p>`,
    });
    return {
      status: outcome,
      castId: decision.castId,
      messageUuid: message.uuid,
      replyMessageUuid: reply?.uuid ?? '',
      rollback: () => tx.rollback(),
    };
  } catch (error) {
    try {
      await tx.rollback();
    } catch (compensation) {
      throw new AggregateError([error, compensation], 'The GM decision and its reply could not be restored.');
    }
    throw error;
  }
}

async function revealInformation(operation, context, tx) {
  if (!operation.fields?.every((field) => immediateRevealFields.has(field)))
    return pendingDecision(operation, context, tx);
  const actors =
    operation.target === 'targets' ? entries(context.targets).map(actorOf) : [actorOf(context.target)];
  if (!actors.length || actors.some((actor) => !actor?.system))
    throw new RuleError('Select the actual target actors before revealing their health.');
  const information = actors.map((actor) => {
    const s = actor.system;
    const result = { name: actor.name };
    if (operation.fields.includes('hp')) result.hp = { value: s.hp.value, max: s.hp.max };
    if (operation.fields.includes('wounds'))
      result.wounds = entries(actor.items)
        .filter((item) => item.type === 'wound')
        .map((item) => ({
          name: item.name,
          treatment: item.system.wound?.treatment,
          location: item.system.wound?.location,
        }));
    if (operation.fields.includes('poison'))
      result.poisoned =
        s.conditions.includes('poison') || s.effects.some((effect) => effect.conditions?.includes('poison'));
    if (operation.fields.includes('disease'))
      result.disease = s.effects
        .filter((effect) => effect.magic?.operation?.rule?.key === 'disease' || effect.key === 'Disease')
        .map((effect) => effect.name ?? effect.key);
    return result;
  });
  await post(
    context,
    {
      content: `<h3>${escaped(context.sourceMagic?.name ?? 'Magical diagnosis')}</h3>${information.map((entry) => `<section><strong>${escaped(entry.name)}</strong>${entry.hp ? `<p>HP: ${entry.hp.value} / ${entry.hp.max}</p>` : ''}${entry.wounds ? `<ul>${entry.wounds.map((wound) => `<li>${escaped(wound.name)} — ${escaped(wound.location)}, ${escaped(wound.treatment)}</li>`).join('') || '<li>No critical injuries.</li>'}</ul>` : ''}${entry.poisoned !== undefined ? `<p>Poisoned: ${entry.poisoned ? 'yes' : 'no'}</p>` : ''}${entry.disease ? `<p>Disease: ${escaped(entry.disease.join(', ') || 'none recorded')}</p>` : ''}</section>`).join('')}`,

      whisper: requesterIds(context),
      flags: flags(context, operation),
    },
    tx
  );
  return tx.result('applied', { information });
}

async function catalogActor(profile, context) {
  if (MAGIC_CREATURE_PROFILES.includes(profile))
    return magicCreatureProfile(profile, { armorItems: context.armorItems });
  if (context.resolveActorProfile) {
    const actor = await context.resolveActorProfile(profile);
    if (actor) return source(actor);
  }
  const name = actorProfiles[profile];
  if (!name) throw new RuleError(`No supported creature profile exists for ${profile}.`);
  const pack = globalThis.game?.packs?.get?.(`${SYSTEM_ID}.bestiary`);
  if (!pack) throw new RuleError('The Bestiary compendium is required to create this creature.');
  const index = await pack.getIndex();
  const entry = entries(index).find((item) => item.name === name);
  if (!entry) throw new RuleError(`The Bestiary does not contain ${name}.`);
  return source(await pack.getDocument(entry._id));
}
function stripIds(data) {
  delete data._id;
  delete data.folder;
  delete data.pack;
  delete data._stats;
  for (const item of data.items ?? []) {
    delete item._id;
    delete item._stats;
  }
  return data;
}
function pointFor(context) {
  const point = context.point;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new RuleError('Choose a valid point on the scene.');
  if (!context.scene) throw new RuleError('A scene is required for this magic.');
  return point;
}
async function createActorWithToken(data, context, tx, offset = 0) {
  const point = pointFor(context);
  const create = context.createActor ?? ((document) => globalThis.Actor.create(document));
  const actor = await tx.created(await create(stripIds(data)));
  const tokenData = actor.getTokenDocument
    ? source(
        await actor.getTokenDocument({
          x: point.x + offset,
          y: point.y,
          elevation: point.elevation ?? context.casterToken?.elevation ?? 0,
        })
      )
    : { ...clone(actor.prototypeToken ?? {}), actorId: actor.id, x: point.x + offset, y: point.y };
  tokenData.actorLink = true;
  tokenData.actorId = actor.id;
  if (point.level ?? context.casterToken?.level) tokenData.level = point.level ?? context.casterToken.level;
  const [token] = await context.scene.createEmbeddedDocuments('Token', [tokenData]);
  await tx.created(token);
  return { actor, token };
}
async function summon(operation, context, tx) {
  if (operation.profile === 'crow') return bondCrows(operation, context, tx);
  const count = operation.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new RuleError('This summon count is outside the book’s supported range.');
  const existing = entries(globalThis.game?.actors).filter(
    (actor) =>
      actor.flags?.[SYSTEM_ID]?.magicWorld?.casterUuid === context.caster.uuid &&
      actor.flags?.[SYSTEM_ID]?.magicWorld?.operation?.profile === operation.profile
  );
  const max = operation.maxBonded ?? operation.maximumControlled ?? operation.maxControlled;
  if (max && existing.length + count > max)
    throw new RuleError(`The caster may control at most ${max} of these creatures.`);
  if (MAGIC_CREATURE_PROFILES.includes(operation.profile) && count !== 1)
    throw new RuleError('This ritual creates exactly one creature.');
  let armorItems = context.armorItems;
  if (operation.profile === 'living-armor' && !armorItems) {
    if (!Array.isArray(operation.armorItemIds) || new Set(operation.armorItemIds).size !== 3)
      throw new RuleError('Select the actual three armor component Items.');
    armorItems = operation.armorItemIds.map((id) => context.caster.items.get(id));
    if (armorItems.some((item) => !item || item.system.quantity < 1))
      throw new RuleError('The actual armor components are unavailable.');
  }
  const template = await catalogActor(operation.profile, { ...context, armorItems });
  const created = [];
  for (let index = 0; index < count; index++) {
    const data = stripIds(clone(template));
    if (operation.profile === 'crow') data.name = 'Bonded Crow';
    data.flags = {
      ...data.flags,
      [SYSTEM_ID]: {
        ...data.flags?.[SYSTEM_ID],
        ...flags(context, operation, {
          expiresAt: operation.duration?.seconds
            ? Number(globalThis.game?.time?.worldTime ?? 0) + operation.duration.seconds
            : null,
        })[SYSTEM_ID],
      },
    };
    data.ownership =
      operation.controllable === false || operation.disposition === 'hostileToEveryone'
        ? { default: 0 }
        : clone(context.caster.ownership ?? { default: 0 });
    data.system.stats = { ...data.system.stats, ...operation.stats };
    for (const [skill, base] of Object.entries(operation.skills ?? {})) {
      const stat = SKILLS[skill]?.[1];
      if (stat) data.system.skills[skill] = Math.max(0, base - data.system.stats[stat]);
    }
    Object.assign(data.system.skills, operation.skillRanks ?? {});
    if (operation.stats?.hp !== undefined) {
      data.system.overrides.hp = operation.stats.hp;
      data.system.hp = { value: operation.stats.hp, max: operation.stats.hp };
      delete data.system.stats.hp;
    }
    if (operation.traits?.controlModifier !== undefined)
      data.system.transport = { ...data.system.transport, control: operation.traits.controlModifier };
    if (operation.traits?.naturalArmor !== undefined)
      for (const location of data.system.locations) {
        location.sp = operation.traits.naturalArmor;
        location.maxSp = operation.traits.naturalArmor;
      }
    if (operation.clawDamage)
      for (const item of data.items ?? [])
        if (item.type === 'weapon' && /claw/i.test(item.name)) item.system.damage = operation.clawDamage;
    if (operation.sapient) data.system.traits = { ...data.system.traits, feralInt: 0, unreasoning: false };
    const pair = await createActorWithToken(
      data,
      context,
      tx,
      index * Number(context.scene.grid?.size ?? 100)
    );
    created.push({ actorUuid: pair.actor.uuid, tokenUuid: pair.token.uuid });
  }
  return tx.result('applied', { summons: created });
}

async function bondCrows(operation, context, tx) {
  const targets = entries(context.targets).map(actorOf).filter(Boolean);
  const unique = new Map(targets.map((actor) => [actor.uuid, actor]));
  if (
    unique.size !== targets.length ||
    targets.length !== operation.count ||
    targets.length < 1 ||
    targets.length > 10
  )
    throw new RuleError('Select the actual distinct crows to bond, matching the chosen count (maximum ten).');
  const worldActors = new Map(
    entries(context.worldActors ?? globalThis.game?.actors).map((actor) => [actor.uuid, actor])
  );
  for (const scene of entries(globalThis.game?.scenes))
    for (const token of entries(scene.tokens))
      if (token.actor) worldActors.set(token.actor.uuid, token.actor);
  for (const actor of targets) worldActors.set(actor.uuid, actor);
  const bonded = [...worldActors.values()].filter(
    (actor) =>
      actor.flags?.[SYSTEM_ID]?.magicWorld?.casterUuid === context.caster.uuid &&
      actor.flags?.[SYSTEM_ID]?.magicWorld?.operation?.profile === 'crow'
  );
  if (
    bonded.length +
      targets.filter((actor) => !bonded.some((existing) => existing.uuid === actor.uuid)).length >
    10
  )
    throw new RuleError('Conspiracy of the Mother permits at most ten bonded crows.');
  for (const actor of targets) {
    const isCrow =
      actor.system?.bestiary?.species === 'crow' ||
      actor.flags?.[SYSTEM_ID]?.species === 'crow' ||
      (await context.validateActorProfile?.(actor, 'crow'));
    if (!isCrow)
      throw new RuleError('The GM must identify this existing creature as a crow before bonding it.');
    if (actor.flags?.[SYSTEM_ID]?.magicWorld?.operation?.profile === 'crow')
      throw new RuleError('This crow is already bonded; resolve its existing bond first.');
    const claws = entries(actor.items).filter(
      (item) => item.type === 'weapon' && item.system.properties?.natural && /claw/i.test(item.name)
    );
    if (!claws.length) throw new RuleError('The selected crow needs its actual natural claw attack.');
    const ownership = clone(actor.ownership ?? {});
    for (const [id, permission] of Object.entries(context.caster.ownership ?? {}))
      if (id !== 'default' && permission >= 3) ownership[id] = permission;
    await tx.update(actor, {
      'system.stats.int': 7,
      'system.stats.ref': 7,
      'system.stats.dex': 7,
      'system.skills.sleightOfHand': 7,
      'system.traits.feralInt': 0,
      ownership,
      [`flags.${SYSTEM_ID}.magicWorld`]: flags(context, operation, {
        permanent: true,
        existingCreature: true,
        bondedAt: Number(globalThis.game?.time?.worldTime ?? 0),
      })[SYSTEM_ID].magicWorld,
    });
    for (const claw of claws) await tx.update(claw, { 'system.damage': '2d6' });
  }
  return tx.result('applied', { bondedActorUuids: targets.map((actor) => actor.uuid), createdActors: 0 });
}

async function coverActor(operation, context, tx) {
  const sp = operation.sp ?? 0,
    hp = operation.hp ?? operation.sp;
  if (hp === undefined) throw new RuleError('The book must define either cover SP or object HP.');
  if (!(sp >= 0) || !(hp > 0)) throw new RuleError('Cover SP and HP must be valid.');
  const name = context.sourceMagic?.name ?? 'Magical cover';
  const data = {
    name,
    type: 'monster',
    img: 'icons/svg/stone-tower.svg',
    system: {
      stats: Object.fromEntries(STATS.map((stat) => [stat, 1])),
      overrides: { hp, sta: 0 },
      hp: { value: hp, max: hp },
      sta: { value: 0, max: 0 },
      race: 'other',
      category: 'object',
      anatomy: 'custom',
      organless: true,
      traits: { mindless: true, unreasoning: true },
      locations: [
        {
          id: 'structure',
          label: 'Structure',
          group: 'torso',
          min: 1,
          max: 10,
          aim: 0,
          multiplier: 1,
          sp: 0,
          maxSp: 0,
        },
      ],
      source: context.sourceMagic?.source ?? '',
      page: context.sourceMagic?.page ?? 0,
      biography: `<p>${escaped(context.sourceMagic?.text ?? '')}</p>`,
    },
    prototypeToken: {
      name,
      actorLink: true,
      texture: { src: 'icons/svg/stone-tower.svg' },
      bar1: { attribute: 'hp' },
    },
    flags: flags(context, operation, {
      cover: {
        sp,
        hp,
        hpResourceTracksSP: operation.hp === undefined,
        shape: clone(operation.shape ?? {}),
        facing: operation.facing ?? 0,
      },
    }),
  };
  const pair = await createActorWithToken(data, context, tx);
  return tx.result('applied', {
    actorUuid: pair.actor.uuid,
    tokenUuid: pair.token.uuid,
    coverSP: sp,
    coverHP: hp,
  });
}

async function temporaryItemPatch(item, patch, operation, context, tx) {
  const previous = Object.fromEntries(
    Object.keys(patch).map((key) => [key, clone(pathValue(source(item), key) ?? null)])
  );
  const effects = clone(item.flags?.[SYSTEM_ID]?.magicItemEffects ?? []);
  if (effects.some((entry) => entry.castId === context.castId && entry.action === operation.action))
    throw new RuleError('This Item has already received this casting.');
  effects.push({
    castId: context.castId,
    key: context.sourceMagic?.key,
    action: operation.action,
    previous,
    applied: clone(patch),
    duration: clone(operation.duration ?? context.duration ?? {}),
    expiresAt: operation.duration?.seconds
      ? Number(globalThis.game?.time?.worldTime ?? 0) + operation.duration.seconds
      : null,
  });
  await tx.update(item, { ...patch, [`flags.${SYSTEM_ID}.magicItemEffects`]: effects });
}

export async function expireWorldItemMagic(item, castId, { user = globalThis.game?.user } = {}) {
  if (!user?.isGM) throw new RuleError('Only a GM expires magical equipment effects.');
  const effects = clone(item.flags?.[SYSTEM_ID]?.magicItemEffects ?? []);
  const expired = effects.filter((entry) => entry.castId === castId);
  const remaining = effects.filter((entry) => entry.castId !== castId);
  for (const removed of expired)
    for (const [key, previous] of Object.entries(removed.previous)) {
      const later = remaining.find(
        (entry) => effects.indexOf(entry) > effects.indexOf(removed) && Object.hasOwn(entry.previous, key)
      );
      if (later && JSON.stringify(later.previous[key]) === JSON.stringify(removed.applied[key]))
        later.previous[key] = clone(previous);
    }
  const patch = { [`flags.${SYSTEM_ID}.magicItemEffects`]: remaining };
  for (const effect of expired.reverse())
    for (const [key, value] of Object.entries(effect.previous)) {
      if (remaining.some((other) => Object.hasOwn(other.applied, key))) continue;
      if (JSON.stringify(pathValue(source(item), key)) !== JSON.stringify(effect.applied[key])) continue;
      patch[key] = value;
    }
  await item.update(patch);
  return { expired: expired.length, itemUuid: item.uuid };
}

async function rollAmount(context, formula) {
  if (typeof context.rollFormula === 'function') {
    const result = await context.rollFormula(formula);
    const total = typeof result === 'number' ? result : result.total;
    if (!Number.isFinite(total) || total < 0) throw new RuleError('The damage roll is invalid.');
    return total;
  }
  const roll = await new globalThis.Roll(formula).evaluate();
  return roll.total;
}

async function itemOperation(operation, context, tx) {
  const owner = actorOf(context.target) ?? context.caster;
  if (operation.action === 'createCover') return coverActor(operation, context, tx);
  if (['recordScar', 'createFood', 'growPlant'].includes(operation.action)) {
    let seed;
    if (operation.action === 'growPlant') {
      seed = await ownedItem(context, operation.seedItemId);
      if (!(seed.system.quantity >= 1) || seed.system.carried === false)
        throw new RuleError('The seed is no longer available.');
      if (!context.scene?.id || !Number.isFinite(context.point?.x) || !Number.isFinite(context.point?.y))
        throw new RuleError('Choose the plant’s actual position within the spell’s range.');
      await tx.update(seed, { 'system.quantity': seed.system.quantity - 1 });
    }
    const name =
      operation.action === 'recordScar'
        ? `Scar: ${operation.text}`
        : operation.action === 'createFood'
          ? 'Magically grown food (one day)'
          : `Mature ${operation.plant}`;
    const data = {
      name,
      type: operation.action === 'recordScar' ? 'ability' : 'gear',
      img: 'icons/svg/item-bag.svg',
      system: {
        quantity: operation.dailyRations ?? 1,
        weight: 0,
        cost: 0,
        source: context.sourceMagic?.source ?? '',
        page: context.sourceMagic?.page ?? 0,
        description: `<p>${escaped(context.sourceMagic?.text ?? '')}</p>`,
        notes: seed
          ? `Grown from ${seed.name}; scene ${context.scene.id}, position ${context.point.x}, ${context.point.y}. One small plant; the spell grants no additional harvest quantity.`
          : operation.location
            ? `Location: ${operation.location}`
            : '',
        carried: operation.action === 'createFood',
      },
      flags: flags(
        context,
        operation,
        seed
          ? {
              seedItemUuid: seed.uuid,
              position: { sceneUuid: context.scene.uuid, ...clone(context.point) },
              growthCompleted: true,
            }
          : {}
      ),
    };
    await createItems(owner, [data], tx);
    return tx.result('applied');
  }
  if (['increaseCoverSP', 'ablateCover'].includes(operation.action)) {
    const document = await resolve(context, operation.coverId);
    const actor = actorOf(document);
    const cover = actor?.flags?.[SYSTEM_ID]?.magicWorld?.cover;
    if (!cover)
      throw new RuleError('Select an actual magic cover Actor or Token with a recorded cover value.');
    if (operation.action === 'increaseCoverSP') {
      if (cover.reinforced) throw new RuleError('This cover area has already benefited from Cryfhau.');
      await tx.update(actor, {
        'system.hp.value': actor.system.hp.value + operation.amount,
        'system.overrides.hp': actor.system.hp.max + operation.amount,
        [`flags.${SYSTEM_ID}.magicWorld.cover`]: {
          ...cover,
          sp: cover.sp + operation.amount,
          reinforced: true,
        },
      });
    } else {
      const amount = await rollAmount(context, operation.formula);
      await tx.update(actor, {
        'system.hp.value': Math.max(0, actor.system.hp.value - amount),
        [`flags.${SYSTEM_ID}.magicWorld.cover.collapsed`]: actor.system.hp.value <= amount,
      });
    }
    return tx.result('applied');
  }
  const id =
    operation.itemId ??
    (operation.action === 'rust' && operation.affectsAllWornArmor
      ? entries(owner.items).find((entry) => entry.type === 'armor' && entry.system.equipped)?.id
      : undefined) ??
    operation.sourceItem ??
    operation.waterId ??
    operation.surface ??
    operation.coverId ??
    operation.projectId ??
    operation.corpseId;
  const item = await ownedItem(context, id);
  if (operation.action === 'property') {
    if (operation.property !== 'balanced' || operation.value !== true || item.type !== 'weapon')
      throw new RuleError('This property operation only supports Balanced on a melee weapon.');
    if (['bow', 'crossbow', 'thrown', 'bomb', 'naturalRanged'].includes(item.system.category))
      throw new RuleError('Blessed Weapon requires a melee weapon.');
    await temporaryItemPatch(item, { 'system.properties.balanced': true }, operation, context, tx);
  } else if (operation.action === 'suppressFocus') {
    if (!(item.system.properties?.focus > 0)) throw new RuleError('This Item has no active Focus.');
    await temporaryItemPatch(item, { 'system.properties.focus': 0 }, operation, context, tx);
  } else if (operation.action === 'inscribe') {
    await tx.update(item, {
      'system.notes': `${item.system.notes ?? ''}\nInscription: ${operation.text}`.trim(),
    });
  } else if (operation.action === 'prepareMutagenExtraction') {
    await tx.update(item, {
      [`flags.${SYSTEM_ID}.mutagenExtraction`]: {
        skills: ['alchemy', 'witcherTraining'],
        dc: 14,
        castId: context.castId,
      },
      'system.notes':
        `${item.system.notes ?? ''}\nMutagen prepared: extract using Alchemy or Witcher Training DC14.`.trim(),
    });
  } else if (operation.action === 'sacrifice') {
    if (item.system.quantity < 1) throw new RuleError('The required Item is already consumed.');
    if (operation.requiredOrigin && item.flags?.[SYSTEM_ID]?.origin !== operation.requiredOrigin)
      throw new RuleError('The selected focus was not created by the required rite.');
    await tx.update(item, { 'system.quantity': item.system.quantity - 1, 'system.equipped': false });
  } else if (operation.action === 'copyConsumable') {
    if (item.flags?.[SYSTEM_ID]?.essenceCopied) throw new RuleError('This source dose was already copied.');
    if (!(item.system.quantity >= 1)) throw new RuleError('The source dose is missing.');
    const water = entries(owner.items).find(
      (candidate) => candidate.name.toLowerCase() === 'essence of water' && candidate.system.quantity >= 1
    );
    if (!water) throw new RuleError('The target inventory needs one unit of Essence of Water.');
    if (item.type !== 'alchemical' || !['potion', 'decoction', 'elixir'].includes(item.system.category))
      throw new RuleError('Select a potion, decoction, or elixir dose.');
    const data = stripIds(source(item));
    data.system.quantity = 1;
    data.flags = {
      ...data.flags,
      [SYSTEM_ID]: {
        ...data.flags?.[SYSTEM_ID],
        essenceCopied: true,
        magicWorld: flags(context, operation)[SYSTEM_ID].magicWorld,
      },
    };
    if (item.system.quantity > 1) {
      // Split the affected original dose; other doses in the stack remain eligible.
      await tx.update(item, { 'system.quantity': item.system.quantity - 1 });
      const originalDose = stripIds(source(item));
      originalDose.system.quantity = 1;
      originalDose.flags = {
        ...originalDose.flags,
        [SYSTEM_ID]: { ...originalDose.flags?.[SYSTEM_ID], essenceCopied: true },
      };
      await createItems(owner, [originalDose], tx);
    } else await tx.update(item, { [`flags.${SYSTEM_ID}.essenceCopied`]: true });
    await tx.update(water, { 'system.quantity': water.system.quantity - 1 });
    await createItems(owner, [data], tx);
  } else if (operation.action === 'rust') {
    const amount = await rollAmount(context, operation.formula);
    const selected = operation.affectsAllWornArmor
      ? entries(owner.items).filter((entry) => entry.type === 'armor' && entry.system.equipped)
      : [item];
    if (!selected.length) throw new RuleError('There is no equipped armor to rust.');
    for (const equipment of selected) {
      const patch = {
        [`flags.${SYSTEM_ID}.rust`]: {
          castId: context.castId,
          penalties: operation.penalties,
          removal: operation.removeRust,
        },
      };
      if (equipment.type === 'armor') {
        const protection = clone(equipment.system.sp ?? {});
        if (!equipment.system.coverage?.length)
          throw new RuleError('Armor has no covered locations to ablate.');
        for (const location of equipment.system.coverage)
          protection[location] = Math.max(
            0,
            Number(protection[location] ?? equipment.system.stoppingPower) - amount
          );
        patch['system.sp'] = protection;
      } else patch['system.reliability'] = Math.max(0, equipment.system.reliability - amount);
      await tx.update(equipment, patch);
    }
  } else if (operation.action === 'transmute') {
    if (/dimeritium/i.test(item.name) || item.flags?.[SYSTEM_ID]?.dimeritiumContact)
      throw new RuleError('Dimeritium and items touching it cannot be transmuted.');
    if (/dimeritium/i.test(operation.material ?? ''))
      throw new RuleError('Transmutation cannot create dimeritium.');
    if (!(item.system.quantity >= 1)) throw new RuleError('A source unit is required.');
    const name = operation.perfectGem ? 'Perfect Gemstone' : operation.material;
    if (!name) throw new RuleError('Choose the resulting metal.');
    const data = stripIds(source(item));
    data.name = name;
    data.system.quantity = 1;
    data.flags = { ...data.flags, ...flags(context, operation) };
    await tx.update(item, { 'system.quantity': item.system.quantity - 1 });
    await createItems(owner, [data], tx);
  } else if (operation.action === 'recoverAlchemySubstance') {
    if (item.flags?.[SYSTEM_ID]?.alchemicalRecovery)
      throw new RuleError('This failed project has already received Alchemical Recovery.');
    const recovered = context.componentSources?.[operation.substance];
    if (!recovered) throw new RuleError('Choose a verified component source from this failed project.');
    const data = stripIds(source(recovered));
    data.system.quantity = 1;
    await tx.update(item, {
      [`flags.${SYSTEM_ID}.alchemicalRecovery`]: { castId: context.castId, substance: operation.substance },
    });
    await createItems(owner, [data], tx);
  } else if (
    ['purifyWater', 'purifyIngots', 'refreshFood', 'forageYield', 'fertileSoil'].includes(operation.action)
  ) {
    const existing = clone(item.flags?.[SYSTEM_ID]?.materialMagic ?? []);
    existing.push({ ...clone(operation), castId: context.castId });
    const patch = { [`flags.${SYSTEM_ID}.materialMagic`]: existing };
    if (operation.action === 'purifyWater' || operation.action === 'refreshFood') {
      patch[`flags.${SYSTEM_ID}.contamination`] = null;
      patch[`flags.${SYSTEM_ID}.spoiled`] = false;
    }
    await tx.update(item, patch);
  } else throw new RuleError('This Item action has no complete world executor.');
  return tx.result('applied');
}

async function transform(operation, context, tx) {
  const actor = context.caster;
  const previous = actor.flags?.[SYSTEM_ID]?.magicTransformation;
  if (previous) return restoreWorldTransformation(actor, context, tx);
  const form = await catalogActor(operation.form, context);
  const before = source(actor);
  const stats = clone(before.system.stats);
  for (const key of ['ref', 'dex', 'body', 'spd']) stats[key] = form.system.stats[key];
  const originalMaxHP = actor.system.hp.max,
    damage = originalMaxHP - actor.system.hp.value;
  const hpMax = form.system.hp.max;
  const record = {
    castId: context.castId,
    form: operation.form,
    operation: clone(operation),
    original: {
      stats: before.system.stats,
      overrides: before.system.overrides,
      anatomy: before.system.anatomy,
      locations: before.system.locations,
      traits: before.system.traits,
      hpMax: originalMaxHP,
      img: before.img,
      tokenTexture: context.casterToken?.texture?.src,
      itemStates: entries(actor.items).map((item) => ({
        id: item.id,
        equipped: item.system.equipped,
        carried: item.system.carried,
      })),
    },
    createdItemIds: [],
  };
  const mergedItems = entries(actor.items).filter(
    (item) => item.type !== 'wound' && ['weapon', 'armor', 'shield', 'gear', 'alchemical'].includes(item.type)
  );
  for (const item of mergedItems)
    await tx.update(item, { 'system.equipped': false, 'system.carried': false });
  const natural = (form.items ?? [])
    .filter((item) => item.type === 'weapon' && item.system.properties?.natural)
    .map((item) => stripIds(clone(item)));
  const added = await createItems(actor, natural, tx);
  record.createdItemIds = added.map((item) => item.id);
  await tx.update(actor, {
    'system.stats': stats,
    'system.overrides': clone(form.system.overrides),
    'system.anatomy': form.system.anatomy,
    'system.locations': clone(form.system.locations),
    'system.traits': clone(form.system.traits),
    'system.hp.value': Math.max(0, hpMax - damage),
    img: form.img,
    [`flags.${SYSTEM_ID}.magicTransformation`]: record,
  });
  if (context.casterToken)
    await tx.update(context.casterToken, { 'texture.src': form.prototypeToken?.texture?.src ?? form.img });
  return tx.result('applied', { actorUuid: actor.uuid, form: operation.form });
}

export async function restoreWorldTransformation(actor, context, existingTransaction) {
  authority({ ...context, caster: actor });
  const state = actor.flags?.[SYSTEM_ID]?.magicTransformation;
  if (!state) throw new RuleError('This actor has no saved original form.');
  if (actor.system.magic?.dimeritiumContact || actor.system.magic?.dimeritiumUnits > 0)
    throw new RuleError('Dimeritium prevents returning from Polymorphism.');
  const tx = existingTransaction ?? transaction({ ...context, caster: actor }, { type: 'transform' });
  const damage = actor.system.hp.max - actor.system.hp.value;
  const original = state.original;
  try {
    const formItems = entries(actor.items).filter((item) => state.createdItemIds.includes(item.id));
    for (const item of formItems) {
      const snapshot = source(item);
      tx.undo.push(() => actor.createEmbeddedDocuments('Item', [snapshot], { keepId: true }));
      await item.delete();
    }
    for (const saved of original.itemStates) {
      const item = actor.items.get(saved.id);
      if (item) await tx.update(item, { 'system.equipped': saved.equipped, 'system.carried': saved.carried });
    }
    await tx.update(actor, {
      'system.stats': clone(original.stats),
      'system.overrides': clone(original.overrides),
      'system.anatomy': original.anatomy,
      'system.locations': clone(original.locations),
      'system.traits': clone(original.traits),
      'system.hp.value': Math.max(
        state.operation.minimumHPOnReturnIfDamageOtherwiseLethal ?? 0,
        original.hpMax - damage
      ),
      img: original.img,
      [`flags.${SYSTEM_ID}.magicTransformation`]: null,
    });
    if (context.casterToken && original.tokenTexture)
      await tx.update(context.casterToken, { 'texture.src': original.tokenTexture });
    return tx.result('applied', { actorUuid: actor.uuid, restored: true });
  } catch (error) {
    if (!existingTransaction) await tx.rollback();
    throw error;
  }
}

async function createZone(operation, context, tx) {
  if (typeof context.createRegion !== 'function')
    throw new RuleError('This area requires the native Foundry Region executor.');
  if (operation.operations?.length && typeof context.applyOperations !== 'function')
    throw new RuleError('Nested region operations need an effect executor.');
  const result = await context.createRegion(operation, context);
  const document = result.document ?? result.region ?? result;
  await tx.created(document);
  if (result.rollback) {
    tx.undo.pop();
    tx.undo.push(result.rollback);
  }
  // Applying enter effects is delegated to the authoritative region event processor, never guessed from token centers here.
  return tx.result('applied', { regionUuid: document.uuid, effectsDeferredToRegionEvents: true });
}

export async function executeWorldMagic(operation, context) {
  authority(context);
  if (!worldOperationSupport(operation))
    throw new RuleError(
      `No complete world executor supports ${operation?.type}:${operation?.action ?? operation?.profile ?? operation?.form ?? ''}.`
    );
  const tx = transaction(context, operation);
  try {
    if (operation.type === 'narrative') return await pendingDecision(operation, context, tx);
    if (operation.type === 'reveal') return await revealInformation(operation, context, tx);
    if (operation.type === 'item') return await itemOperation(operation, context, tx);
    if (operation.type === 'summon') return await summon(operation, context, tx);
    if (operation.type === 'transform') return await transform(operation, context, tx);
    if (operation.type === 'zone') return await createZone(operation, context, tx);
    throw new RuleError('Unknown world operation.');
  } catch (error) {
    try {
      await tx.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Magic failed and compensation needs GM review.');
    }
    throw error;
  }
}

let decisionHandlerRegistered = false;
/** Install once from system ready; the supplied submit callback may route through elected-GM authority. */
export function registerWorldMagicDecisionHandlers({ submitDecision } = {}) {
  if (decisionHandlerRegistered) return;
  decisionHandlerRegistered = true;
  globalThis.Hooks.on('renderChatMessageHTML', (message, html) => {
    const element = html?.[0] ?? html;
    const decision = message.getFlag?.(SYSTEM_ID, 'magicDecision');
    if (!decision || decision.status !== 'pendingGM' || !globalThis.game?.user?.isGM) return;
    for (const button of element.querySelectorAll('[data-witcher-world-decision]'))
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const answer = await globalThis.foundry.applications.api.DialogV2.input({
            window: { title: 'Record the magical outcome' },
            content:
              '<label>Result<select name="outcome"><option value="resolved">Resolved</option><option value="declined">Effect declined</option></select></label><label>Actual ruling or information<textarea name="answer" required rows="5"></textarea></label>',
            ok: { label: 'Record ruling' },
          });
          if (!answer) return;
          if (submitDecision) await submitDecision(message.uuid, answer);
          else await resolveWorldMagicDecision(message, answer);
        } catch (error) {
          globalThis.ui?.notifications?.error(error.message);
        } finally {
          button.disabled = false;
        }
      });
  });
}
