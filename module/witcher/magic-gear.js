import { SYSTEM_ID } from './config.js';
import { TROPHY_INSTALLED_HOOKS } from './magic-trophies.js';
import { RuleError } from './rules.js';
import { MAGIC, magicInfo } from './magic-catalog.js';
import { registerCommand, runCommand, authorizedActor } from './authority.js';
import { isPrimaryActiveGm, resolveFoundryUuid } from '../foundry-compat.js';
import { commitActor, chat, prompt, input, escapeHTML as e, serial, errorNotice } from './runtime.js';
import { executeWorldMagic } from './magic-world-effects.js';
import { magicSceneScale } from './magic-regions.js';
import { removeMagicEffects, addMagicEffect } from './magic-state.js';
import {
  TROPHIES,
  artifactItemData,
  ritualArtifact,
  artifactAvailable,
  wornArtifact,
  amuletGrantedItems,
  amuletImbuementCost,
  AMULET_DRAWBACKS,
  amuletDrawbackPlan,
  pendantSuppressionPlan,
  trophyBenefits,
  trophySupport,
} from './magic-gear-rules.js';
export * from './magic-gear-rules.js';
export { beginAmuletImbuement, amuletImbuementInterruption } from './magic-amulet-crafting.js';
import { registerAmuletCrafting } from './magic-amulet-crafting.js';

const copy = (value) => structuredClone(value);
const rows = (value) => value?.contents ?? Array.from(value ?? []);
const now = () => game.time.worldTime;
const idFor = () => foundry.utils.randomID();
let services = {};
function artifactOf(actor, id, key) {
  const item = actor.items.get(id),
    artifact = ritualArtifact(item);
  if (!artifact || (key && artifact.key !== key))
    throw new RuleError('This ritual artifact is no longer present.');
  return { item, artifact };
}
function actors() {
  return [
    ...new Map(
      [
        ...rows(game.actors),
        ...rows(game.scenes).flatMap((scene) =>
          rows(scene.tokens)
            .map((token) => token.actor)
            .filter(Boolean)
        ),
      ].map((actor) => [actor.uuid, actor])
    ).values(),
  ];
}
function itemPatch(item, artifact) {
  return { _id: item.id, [`flags.${SYSTEM_ID}.ritualArtifact`]: artifact };
}
function sourceTags(context, extra = {}) {
  return { castId: context.castId, casterUuid: context.actor.uuid, createdAt: context.time, ...extra };
}

/** Standalone document operations retain explicit inverse operations so the
 * ritual engine can compensate them after a later actor/chat write failure. */
function transaction() {
  const undo = [];
  return {
    async update(document, changes) {
      const before = document.toObject();
      await document.update(changes, { witcherMagicGear: true });
      undo.push(() => document.update(before, { diff: false, recursive: false, witcherMagicGear: true }));
    },
    async created(document) {
      undo.push(() => document.delete({ witcherMagicGear: true }));
      return document;
    },
    async removed(document) {
      const before = document.toObject(),
        parent = document.parent,
        type = document.documentName;
      await document.delete({ witcherMagicGear: true });
      undo.push(() =>
        parent.createEmbeddedDocuments(type, [before], { keepId: true, witcherMagicGear: true })
      );
    },
    addUndo(callback) {
      undo.push(callback);
    },
    async rollback() {
      const failures = [];
      for (const restore of undo.reverse())
        try {
          await restore();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length) throw new AggregateError(failures, 'Artifact rollback needs GM review.');
    },
    result(receipt, status = 'applied') {
      return { status, receipt, rollback: () => this.rollback() };
    },
  };
}
async function createArtifact(context, kind, details) {
  const data = artifactItemData(kind, { ...sourceTags(context), ...details });
  const created = await context.actor.createEmbeddedDocuments('Item', [data]);
  return {
    status: 'applied',
    receipt: { itemUuid: created[0].uuid },
    rollback: () =>
      context.actor.deleteEmbeddedDocuments(
        'Item',
        created.map((item) => item.id)
      ),
  };
}

export function magicGearProcedureFields({ actor, magic }) {
  const inventory = rows(actor.items).filter((item) => artifactAvailable(item) && item.type !== 'magic');
  if (magic.key === 'create-crystal-skull') return '';
  if (magic.key === 'imbue-trophy')
    return (
      input('gear_trophy', 'Actual nonmagical trophy', {
        options: Object.fromEntries(
          inventory.filter((item) => !ritualArtifact(item)).map((item) => [item.id, item.name])
        ),
      }) +
      input('gear_species', 'Adult monster species', {
        options: Object.fromEntries(Object.entries(TROPHIES).map(([key, value]) => [key, value.name])),
      }) +
      '<p>GM: record everyone who contributed to killing this monster.</p>' +
      rows(game.actors)
        .map((other) => input(`gear_helper_${other.uuid}`, other.name, { type: 'checkbox' }))
        .join('')
    );
  return '';
}
export function magicGearProcedureChoices({ magic, form }) {
  if (magic.key === 'create-crystal-skull') return {};
  if (magic.key === 'imbue-trophy')
    return {
      trophyItemId: form.gear_trophy,
      species: form.gear_species,
      helpedKillActorUuids: Object.entries(form)
        .filter(([key, value]) => key.startsWith('gear_helper_') && value === true)
        .map(([key]) => key.slice(12)),
    };
  return {};
}

export async function prepareMagicGearEntry({ actor, magic }) {
  if (magic.key !== 'create-crystal-skull') return {};
  const inert = rows(actor.items).filter(
    (item) =>
      artifactAvailable(item) &&
      ritualArtifact(item)?.key === 'create-crystal-skull' &&
      !ritualArtifact(item).charged
  );
  const form = await prompt(
    'Create or recharge Crystal Skull',
    input('animal', 'Animal skull', {
      options: { cat: 'Cat', dog: 'Dog', bird: 'Bird', serpent: 'Serpent' },
    }) +
      input('rechargeItemId', 'Actual inert skull (recharge)', {
        options: {
          '': 'Create a new skull',
          ...Object.fromEntries(inert.map((item) => [item.id, item.name])),
        },
      }),
    { button: 'Choose materials' }
  );
  if (!form) return null;
  if (form.rechargeItemId) form.animal = ritualArtifact(actor.items.get(form.rechargeItemId)).animal;
  return { animal: form.animal, rechargeItemId: form.rechargeItemId || '' };
}
export function magicGearComponentRequirements({ actor, magic, choices }) {
  if (magic.key !== 'create-crystal-skull' || !choices.rechargeItemId) return undefined;
  const { item, artifact } = artifactOf(actor, choices.rechargeItemId, 'create-crystal-skull');
  if (artifact.charged || artifact.active || !artifactAvailable(item))
    throw new RuleError('Choose an actual inert, carried Crystal Skull.');
  return [
    {
      id: 'inert-skull',
      name: item.name,
      quantity: 1,
      kind: 'retain',
      itemId: item.id,
      printed: 'Inert Crystal Skull',
    },
    { id: 'essence', name: 'Fifth Essence', quantity: 2, kind: 'consume', printed: 'Fifth Essence (x2)' },
  ];
}

export function createMagicGearAdapters() {
  return {
    trophy: {
      async preflight(context) {
        const choices = context.choices,
          item = context.actor.items.get(choices.trophyItemId);
        if (!game.user.isGM)
          throw new RuleError('The GM verifies the monster kill and eligible contributors.');
        if (
          !item ||
          !artifactAvailable(item) ||
          item.system.quantity !== 1 ||
          ritualArtifact(item) ||
          !TROPHIES[choices.species]
        )
          throw new RuleError(
            'Choose one real, previously nonmagical adult-monster trophy and its printed species.'
          );
        if (!Array.isArray(choices.helpedKillActorUuids) || !choices.helpedKillActorUuids.length)
          throw new RuleError('Record the characters who helped kill this monster.');
        for (const uuid of choices.helpedKillActorUuids)
          if (!(await resolveFoundryUuid(uuid))?.system)
            throw new RuleError('An eligible hunter actor no longer exists.');
      },
      async prepare(operation, context) {
        const item = context.actor.items.get(operation.itemId);
        if (!item || ritualArtifact(item))
          throw new RuleError('The trophy changed before imbuement completed.');
        return {
          plans: [
            {
              actor: context.actor,
              changes: {},
              items: [
                itemPatch(
                  item,
                  sourceTags(context, {
                    key: 'imbue-trophy',
                    species: operation.species,
                    helpedKillActorUuids: operation.helpedKillActorUuids,
                    activeActorUuid: '',
                  })
                ),
              ],
            },
          ],
        };
      },
    },
    crystalSkull: {
      async preflight(context) {
        const { animal, rechargeItemId } = context.choices;
        if (!['cat', 'dog', 'bird', 'serpent'].includes(animal))
          throw new RuleError('Choose the actual animal skull.');
        if (rechargeItemId) {
          const { artifact, item } = artifactOf(context.actor, rechargeItemId, 'create-crystal-skull');
          if (artifact.charged || artifact.active || !artifactAvailable(item) || artifact.animal !== animal)
            throw new RuleError('Only the matching inert Crystal Skull can be recharged.');
          if (context.allocations?.['inert-skull']?.itemId !== rechargeItemId)
            throw new RuleError('Retain the exact inert skull selected for recharge.');
        }
      },
      async prepare(operation, context) {
        if (operation.rechargeItemId) {
          const { item, artifact } = artifactOf(
            context.actor,
            operation.rechargeItemId,
            'create-crystal-skull'
          );
          if (artifact.charged || artifact.active)
            throw new RuleError('This Crystal Skull is no longer inert.');
          return {
            plans: [
              {
                actor: context.actor,
                changes: {},
                items: [itemPatch(item, { ...copy(artifact), charged: true, rechargedAt: context.time })],
              },
            ],
          };
        }
        return {
          plans: [],
          execute: () => createArtifact(context, 'crystalSkull', { animal: operation.animal }),
        };
      },
    },
    hexPendant: {
      async prepare(operation, context) {
        return {
          plans: [],
          execute: () =>
            createArtifact(context, 'hexPendant', { expiresAt: context.time + operation.duration.seconds }),
        };
      },
    },
  };
}

export function magicGearActorChanges(actor, items = rows(actor.items)) {
  const projected = copy(actor.system.toObject());
  const suppression = pendantSuppressionPlan(projected, items, now());
  Object.assign(projected, suppression);
  projected.effects = amuletDrawbackPlan(projected, items, now(), idFor);
  const active = trophyBenefits(items, actor.uuid);
  projected.effects = projected.effects.filter((effect) => !effect.magic?.trophyBenefit);
  if (active.itemId)
    projected.effects.push({
      id: `trophy-${active.itemId}`,
      key: `${TROPHIES[active.species].name} Trophy`,
      expires: 0,
      modifiers: active.modifiers,
      magic: { key: 'trophy-benefit', trophyBenefit: { itemId: active.itemId, species: active.species } },
    });
  const changes = {};
  if (JSON.stringify(projected.effects) !== JSON.stringify(actor.system.effects))
    changes['system.effects'] = projected.effects;
  if (JSON.stringify(projected.conditions) !== JSON.stringify(actor.system.conditions))
    changes['system.conditions'] = projected.conditions;
  return changes;
}
export async function synchronizeMagicGear(actor) {
  const items = rows(actor.items),
    changes = magicGearActorChanges(actor, items);
  if (Object.keys(changes).length) await actor.update(changes, { witcherMagicGear: true });
  const grants = items.filter((item) => item.flags?.[SYSTEM_ID]?.magicAmulet),
    needed = [];
  for (const amulet of items.filter(
    (item) => ritualArtifact(item)?.key === 'enchant-amulet' && ritualArtifact(item).complete
  )) {
    for (const data of amuletGrantedItems(amulet))
      if (
        !grants.some(
          (grant) =>
            grant.flags[SYSTEM_ID].magicAmulet.amuletId === amulet.id &&
            grant.flags[SYSTEM_ID].magicAmulet.key === data.flags[SYSTEM_ID].magicAmulet.key
        )
      )
        needed.push(data);
  }
  if (needed.length) await actor.createEmbeddedDocuments('Item', needed, { witcherMagicGear: true });
  const stale = grants.filter((grant) => {
    const info = grant.flags[SYSTEM_ID].magicAmulet,
      item = actor.items.get(info.amuletId);
    return !ritualArtifact(item)?.storedMagic?.some((entry) => entry.key === info.key);
  });
  if (stale.length)
    await actor.deleteEmbeddedDocuments(
      'Item',
      stale.map((item) => item.id),
      { witcherMagicGear: true }
    );
  return changes;
}

async function tokenFor(actor, uuid) {
  const token = await resolveFoundryUuid(uuid);
  if (token?.documentName !== 'Token' || token.actor?.uuid !== actor.uuid)
    throw new RuleError('Choose this actor’s actual scene token.');
  return token;
}
function distance(a, b) {
  if (!a || !b || a.parent?.uuid !== b.parent?.uuid) return Infinity;
  const scale = magicSceneScale(a.parent),
    grid = a.parent.grid.size;
  const dx = Math.max(
    0,
    Math.abs(a.x + (a.width * grid) / 2 - b.x - (b.width * grid) / 2) - ((a.width + b.width) * grid) / 2
  );
  const dy = Math.max(
    0,
    Math.abs(a.y + (a.height * grid) / 2 - b.y - (b.height * grid) / 2) - ((a.height + b.height) * grid) / 2
  );
  return Math.hypot(
    dx / scale.pixelsPerMetre,
    dy / scale.pixelsPerMetre,
    (a.elevation - b.elevation) * scale.metresPerUnit
  );
}
async function activateSkull({ actorUuid, itemId, tokenUuid }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    { item, artifact } = artifactOf(actor, itemId, 'create-crystal-skull');
  if (!artifactAvailable(item) || !artifact.charged || artifact.active)
    throw new RuleError('Only a carried charged Crystal Skull can be activated.');
  if (
    actor.system.magic?.speech === false ||
    actor.system.conditions.some((condition) => ['dead', 'stunned', 'unconscious'].includes(condition)) ||
    actor.system.effects.some(
      (effect) => effect.magic?.operation?.rule?.key === 'silenced' && !effect.magic.suppressed
    )
  )
    throw new RuleError('The owner must be able to speak the activation word.');
  const casterToken = await tokenFor(actor, tokenUuid),
    scene = casterToken.parent;
  const point = {
    x: casterToken.x + casterToken.width * scene.grid.size,
    y: casterToken.y,
    elevation: casterToken.elevation,
    level: casterToken.level,
  };
  const tx = transaction();
  try {
    let animal = artifact.animalActorUuid ? await resolveFoundryUuid(artifact.animalActorUuid) : null,
      token;
    if (animal) {
      await tx.update(animal, {
        'system.hp.value': animal.system.hp.max,
        'system.conditions': animal.system.conditions.filter(
          (condition) => !['dead', 'unconscious', 'stunned'].includes(condition)
        ),
        'system.deathSaves': 0,
        'system.pendingDeathSaves': 0,
        ownership: copy(actor.ownership),
      });
      const data = (await animal.getTokenDocument(point)).toObject();
      data.actorLink = true;
      data.actorId = animal.id;
      token = await tx.created((await scene.createEmbeddedDocuments('Token', [data]))[0]);
    } else {
      const result = await executeWorldMagic(
        { type: 'summon', profile: artifact.animal, count: 1, controllable: true },
        {
          ...services.worldContext?.({ actor, item, casterToken }),
          castId: artifact.castId || item.uuid,
          caster: actor,
          casterToken,
          scene,
          point,
          sourceMagic: magicInfo('create-crystal-skull'),
          user: game.user,
        }
      );
      tx.addUndo(result.rollback);
      animal = await resolveFoundryUuid(result.receipt.summons[0].actorUuid);
      token = await resolveFoundryUuid(result.receipt.summons[0].tokenUuid);
    }
    await tx.update(animal, {
      [`flags.${SYSTEM_ID}.crystalSkull`]: {
        itemUuid: item.uuid,
        ownerActorUuid: actor.uuid,
        commandRange: 50,
      },
    });
    await tx.update(item, {
      'system.carried': false,
      'system.equipped': false,
      [`flags.${SYSTEM_ID}.ritualArtifact`]: {
        ...copy(artifact),
        active: true,
        animalActorUuid: animal.uuid,
        tokenUuid: token.uuid,
      },
    });
    await chat(
      actor,
      'Crystal Skull activated',
      `<p>${e(item.name)} becomes the same ${e(artifact.animal)}. Mental commands reach50m; without commands it behaves as an ordinary animal.</p>`
    );
    return item;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
async function commandSkull({ actorUuid, itemId, tokenUuid, order }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    { artifact } = artifactOf(actor, itemId, 'create-crystal-skull');
  const source = await tokenFor(actor, tokenUuid),
    target = await resolveFoundryUuid(artifact.tokenUuid);
  if (!artifact.active || !target?.actor || distance(source, target) > 50)
    throw new RuleError('The living Crystal Skull animal must be within50m.');
  if (!String(order ?? '').trim()) throw new RuleError('State the actual mental command.');
  return chat(actor, `Mental command → ${target.name}`, `<p>${e(order)}</p>`, {
    flags: { kind: 'crystal-skull-order', animalUuid: target.actor.uuid, itemId },
  });
}
async function skullDied(animal) {
  const link = animal.flags?.[SYSTEM_ID]?.crystalSkull;
  if (!link || !animal.system.conditions.includes('dead')) return;
  const item = await resolveFoundryUuid(link.itemUuid),
    artifact = ritualArtifact(item);
  if (!artifact?.active) return;
  const token = await resolveFoundryUuid(artifact.tokenUuid),
    tx = transaction();
  try {
    let ground = null;
    if (token) {
      const tile = await tx.created(
        (
          await token.parent.createEmbeddedDocuments('Tile', [
            {
              texture: { src: item.img },
              x: token.x,
              y: token.y,
              width: token.parent.grid.size / 2,
              height: token.parent.grid.size / 2,
              elevation: token.elevation,
              flags: { [SYSTEM_ID]: { crystalSkullItemUuid: item.uuid } },
            },
          ])
        )[0]
      );
      ground = {
        sceneUuid: token.parent.uuid,
        x: token.x,
        y: token.y,
        elevation: token.elevation,
        level: token.level,
        tileUuid: tile.uuid,
      };
      await tx.removed(token);
    }
    await tx.update(item, {
      'system.carried': false,
      'system.equipped': false,
      [`flags.${SYSTEM_ID}.ritualArtifact`]: {
        ...copy(artifact),
        active: false,
        charged: false,
        tokenUuid: '',
        ground,
      },
    });
    await chat(
      animal,
      'Crystal Skull becomes inert',
      '<p>The dead animal reverts to its inert skull at its last position. Retrieve it and recharge with the ritual and2 Fifth Essence.</p>'
    );
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
async function retrieveSkull({ actorUuid, itemId, tokenUuid }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    { item, artifact } = artifactOf(actor, itemId, 'create-crystal-skull');
  if (!artifact.ground || artifact.active) throw new RuleError('This skull is not on the ground.');
  const source = await tokenFor(actor, tokenUuid),
    ground = artifact.ground;
  const point = {
    parent: source.parent,
    x: ground.x,
    y: ground.y,
    elevation: ground.elevation,
    width: 0,
    height: 0,
  };
  if (source.parent.uuid !== ground.sceneUuid || source.level !== ground.level || distance(source, point) > 2)
    throw new RuleError('Move within2m of the actual inert skull.');
  const tile = await resolveFoundryUuid(ground.tileUuid),
    tx = transaction();
  try {
    await tx.update(item, {
      'system.carried': true,
      [`flags.${SYSTEM_ID}.ritualArtifact`]: { ...copy(artifact), ground: null },
    });
    if (tile) await tx.removed(tile);
    await chat(
      actor,
      'Crystal Skull retrieved',
      `<p>${e(item.name)} is back in inventory, still inert until recharged.</p>`
    );
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function attuneTrophy({ actorUuid, itemId, resistance }, { user }) {
  const actor = await authorizedActor(actorUuid, user),
    { item, artifact } = artifactOf(actor, itemId, 'imbue-trophy');
  if (!wornArtifact(item) || !artifact.helpedKillActorUuids?.includes(actor.uuid))
    throw new RuleError('Wear/touch the actual trophy from a monster this character helped kill.');
  const previous = actor.flags?.[SYSTEM_ID]?.magicGear ?? {},
    changing = previous.activeTrophyUuid && previous.activeTrophyUuid !== item.uuid;
  if (changing && previous.attuning?.itemUuid !== item.uuid)
    return commitActor(
      actor,
      {
        [`flags.${SYSTEM_ID}.magicGear`]: {
          ...copy(previous),
          attuning: { itemUuid: item.uuid, startedAt: now(), readyAt: now() + 3600 },
        },
      },
      [],
      () =>
        chat(
          actor,
          'Meditate over a trophy',
          '<p>Switching trophies requires one hour; advance world time before finishing.</p>'
        )
    );
  if (changing && now() < previous.attuning.readyAt)
    throw new RuleError('One full hour of meditation is required to switch trophies.');
  if (artifact.species === 'frightener') {
    if (!['slashing', 'piercing', 'bludgeoning'].includes(resistance))
      throw new RuleError('Select the Frightener trophy’s damage resistance.');
    if (
      artifact.resistance &&
      artifact.resistance !== resistance &&
      artifact.resistanceDay === Math.floor(now() / 86400)
    )
      throw new RuleError('The Frightener resistance has already been chosen today.');
  }
  const items = rows(actor.items)
    .filter((row) => ritualArtifact(row)?.key === 'imbue-trophy')
    .map((row) =>
      itemPatch(row, {
        ...copy(ritualArtifact(row)),
        activeActorUuid: row.id === itemId ? actor.uuid : '',
        ...(row.id === itemId && artifact.species === 'frightener'
          ? { resistance, resistanceDay: Math.floor(now() / 86400) }
          : {}),
      })
    );
  const projectedItems = rows(actor.items).map((row) => ({
    ...row.toObject(),
    id: row.id,
    uuid: row.uuid,
    flags: {
      ...copy(row.flags),
      [SYSTEM_ID]: {
        ...copy(row.flags?.[SYSTEM_ID]),
        ritualArtifact:
          items.find((change) => change._id === row.id)?.[`flags.${SYSTEM_ID}.ritualArtifact`] ??
          ritualArtifact(row),
      },
    },
  }));
  return commitActor(
    actor,
    {
      ...magicGearActorChanges(actor, projectedItems),
      [`flags.${SYSTEM_ID}.magicGear`]: { ...copy(previous), activeTrophyUuid: item.uuid, attuning: null },
    },
    items,
    () =>
      chat(
        actor,
        'Trophy attuned',
        `<p>${e(item.name)} now grants its one magical benefit while in physical contact.</p>`
      )
  );
}

async function expirePendant(actor, item) {
  const artifact = ritualArtifact(item);
  if (
    artifact?.key !== 'wagerers-pendant' ||
    artifact.expired ||
    artifact.pendingSetup ||
    artifact.expiresAt > now()
  )
    return;
  const hexed = wornArtifact(item) && actor.system.effects.some((effect) => effect.magic?.kind === 'hex');
  const tokens = rows(game.scenes)
    .flatMap((scene) => rows(scene.tokens))
    .filter((token) => token.actor?.uuid === actor.uuid);
  const burstTargets =
    hexed && tokens.length === 1
      ? rows(tokens[0].parent.tokens)
          .filter((token) => token.actor && distance(tokens[0], token) <= 2)
          .map((token) => token.uuid)
      : null;
  const next = {
    ...copy(artifact),
    expired: true,
    broken: hexed,
    pendingBurst: hexed,
    burstTargets,
    wearerTokenUuid: tokens.length === 1 ? tokens[0].uuid : '',
  };
  await commitActor(actor, magicGearActorChanges(actor), [itemPatch(item, next)], async () => {
    return chat(
      actor,
      'Wagerer’s Pendant expires',
      hexed
        ? `<p>Unlifted hexes remain. The pendant breaks; the GM chooses the actual hexes for the wearer and everyone within2m.</p><button type="button" data-magic-gear="burst" data-actor="${e(actor.uuid)}" data-item="${e(item.id)}">Resolve hex burst (GM)</button>`
        : '<p>The pendant expires without a hexed wearer. Its suppression ends.</p>',
      { flags: { kind: 'pendant-expiry', actorUuid: actor.uuid, itemId: item.id } }
    );
  });
}
async function pendantBurst({ actorUuid, itemId, tokenUuid, hexKeys }, { user, id }) {
  if (!user.isGM) throw new RuleError('The GM selects the hexes released by this pendant.');
  const actor = await authorizedActor(actorUuid, user),
    { item, artifact } = artifactOf(actor, itemId, 'wagerers-pendant');
  if (!artifact.pendingBurst || artifact.burstResolved)
    throw new RuleError('This pendant has no unresolved burst.');
  if (!Array.isArray(hexKeys) || !hexKeys.length || hexKeys.some((key) => magicInfo(key)?.kind !== 'hex'))
    throw new RuleError('Select actual hexes for this burst.');
  const source = await tokenFor(actor, artifact.wearerTokenUuid || tokenUuid);
  const targets = artifact.burstTargets
    ? (await Promise.all(artifact.burstTargets.map(resolveFoundryUuid))).filter((token) => token?.actor)
    : rows(source.parent.tokens).filter((token) => token.actor && distance(source, token) <= 2);
  const { hexEffectData } = await import('./magic-procedures.js');
  const plans = [...new Map(targets.map((token) => [token.actor.uuid, token.actor])).values()].map(
    (target) => {
      let state = copy(target.system.toObject());
      for (const key of [...new Set(hexKeys)])
        Object.assign(
          state,
          addMagicEffect(
            state,
            hexEffectData(magicInfo(key), {
              castId: id,
              casterUuid: actor.uuid,
              checkTotal: 0,
              createdAt: now(),
              id: idFor(),
            })
          )
        );
      return {
        actor: target,
        changes: { 'system.effects': state.effects, 'system.conditions': state.conditions },
      };
    }
  );
  const commit = async (index) =>
    index >= plans.length
      ? commitActor(
          actor,
          {},
          [itemPatch(item, { ...copy(artifact), pendingBurst: false, burstResolved: true })],
          () =>
            chat(
              actor,
              'Pendant hex burst',
              `<p>${targets.map((token) => e(token.name)).join(', ')} receive ${hexKeys.map((key) => e(magicInfo(key).name)).join(', ')}.</p>`
            )
        )
      : commitActor(plans[index].actor, plans[index].changes, [], () => commit(index + 1));
  return commit(0);
}

async function configureArtifact({ actorUuid, itemId, values = {} }, { user }) {
  if (!user.isGM) throw new RuleError('The GM records the actual acquired artifact configuration.');
  const actor = await authorizedActor(actorUuid, user),
    { item, artifact } = artifactOf(actor, itemId);
  if (!artifact.pendingSetup) throw new RuleError('This artifact has already been configured.');
  const next = { ...copy(artifact), pendingSetup: false };
  if (artifact.key === 'enchant-amulet') {
    if (
      !Array.isArray(values.storedMagic) ||
      values.storedMagic.length !== artifact.slots ||
      new Set(values.storedMagic.map((row) => row.key)).size !== artifact.slots
    )
      throw new RuleError(`Configure exactly ${artifact.slots} different actual spells/invocations.`);
    next.storedMagic = values.storedMagic.map((row) => ({
      key: row.key,
      ...amuletImbuementCost(magicInfo(row.key), Number(row.power)),
    }));
    if (artifact.slots > 1 && !AMULET_DRAWBACKS[values.drawback])
      throw new RuleError('Record the creator’s actual multi-spell drawback.');
    next.drawback = artifact.slots > 1 ? values.drawback : null;
    next.complete = true;
  } else if (artifact.key === 'imbue-trophy') {
    if (!Array.isArray(values.helpedKillActorUuids) || !values.helpedKillActorUuids.length)
      throw new RuleError('Record at least one participant in the actual monster kill.');
    for (const uuid of values.helpedKillActorUuids)
      if (!(await resolveFoundryUuid(uuid))?.system)
        throw new RuleError('The eligible hunter no longer exists.');
    next.helpedKillActorUuids = [...new Set(values.helpedKillActorUuids)];
  } else if (artifact.key === 'wagerers-pendant') {
    if (!Number.isFinite(values.expiresAt) || values.expiresAt <= now())
      throw new RuleError('Record the pendant’s actual future expiry (one week after its creation).');
    next.expiresAt = values.expiresAt;
  } else throw new RuleError('This artifact requires no additional configuration.');
  const replacement = {
    ...item.toObject(),
    id: item.id,
    uuid: item.uuid,
    flags: { ...copy(item.flags), [SYSTEM_ID]: { ...copy(item.flags[SYSTEM_ID]), ritualArtifact: next } },
  };
  const changes = magicGearActorChanges(
    actor,
    rows(actor.items).map((row) => (row.id === item.id ? replacement : row))
  );
  let grants = [];
  try {
    return await commitActor(actor, changes, [itemPatch(item, next)], async () => {
      if (next.key === 'enchant-amulet')
        grants = await actor.createEmbeddedDocuments('Item', amuletGrantedItems(item), {
          witcherMagicGear: true,
        });
      return chat(actor, 'Artifact configured', `<p>${e(item.name)} has its actual recorded properties.</p>`);
    });
  } catch (error) {
    if (grants.length)
      await actor.deleteEmbeddedDocuments(
        'Item',
        grants.map((row) => row.id),
        { witcherMagicGear: true }
      );
    throw error;
  }
}
export function magicGearDisplay(item) {
  const artifact = ritualArtifact(item);
  if (!artifact) return null;
  return {
    ...copy(artifact),
    itemId: item.id,
    name: item.name,
    tableRules:
      artifact.key === 'imbue-trophy' && !trophySupport(artifact.species, TROPHY_INSTALLED_HOOKS).supported
        ? TROPHIES[artifact.species]?.text
        : '',
    canConfigure: !!artifact.pendingSetup && !!game.user.isGM,
    canActivate:
      artifact.key === 'create-crystal-skull' &&
      artifactAvailable(item) &&
      artifact.charged &&
      !artifact.active,
    canCommand: artifact.key === 'create-crystal-skull' && artifact.active,
    canRetrieve: artifact.key === 'create-crystal-skull' && !!artifact.ground,
    canAttune: artifact.key === 'imbue-trophy' && wornArtifact(item),
    canBurst: artifact.key === 'wagerers-pendant' && artifact.pendingBurst && !!game.user.isGM,
    amuletSpells:
      artifact.key === 'enchant-amulet'
        ? artifact.storedMagic.map((entry) => ({ ...entry, name: magicInfo(entry.key)?.name ?? entry.key }))
        : [],
  };
}
async function selectedToken(actor) {
  const selected = rows(canvas.tokens.controlled)
    .map((token) => token.document)
    .filter((token) => token.actor?.uuid === actor.uuid);
  const candidates = selected.length
    ? selected
    : rows(canvas.scene.tokens).filter((token) => token.actor?.uuid === actor.uuid);
  if (!candidates.length) throw new RuleError('Place this actor on the viewed scene.');
  if (candidates.length === 1) return candidates[0];
  const choice = await prompt(
    'Choose artifact user token',
    input('tokenId', 'Token', {
      options: Object.fromEntries(candidates.map((token) => [token.id, token.name])),
    }),
    { button: 'Choose' }
  );
  return choice ? candidates.find((token) => token.id === choice.tokenId) : null;
}
export async function magicGearAction(actor, item, action, key = '') {
  if (action === 'configure') {
    if (!game.user.isGM) throw new RuleError('The GM configures acquired artifacts.');
    const artifact = ritualArtifact(item);
    let fields = '';
    if (artifact.key === 'enchant-amulet') {
      const options = Object.fromEntries(
        MAGIC.filter((row) => ['spell', 'invocation'].includes(row.kind)).map((row) => [row.key, row.name])
      );
      for (let i = 0; i < artifact.slots; i++)
        fields += input(`spell_${i}`, `Stored spell ${i + 1}`, { options });
      if (artifact.slots > 1)
        fields += input('drawback', 'Creator’s chosen drawback', {
          options: { hp: 'Maximum HP −5', headache: 'INT/WILL/REF −1', sta: 'Maximum STA −10' },
        });
    } else if (artifact.key === 'imbue-trophy')
      fields =
        '<p>Select the characters who actually helped kill the adult monster.</p>' +
        rows(game.actors)
          .map((row) => input(`hunter_${row.uuid}`, row.name, { type: 'checkbox' }))
          .join('');
    else if (artifact.key === 'wagerers-pendant')
      fields = input('expiresAt', 'Expiry (world seconds; one week after creation)', {
        value: now() + 604800,
        min: now() + 1,
      });
    const form = await prompt('Configure acquired artifact', fields, { button: 'Record actual properties' });
    if (!form) return;
    const values = {
      drawback: form.drawback,
      expiresAt: Number(form.expiresAt),
      helpedKillActorUuids: Object.entries(form)
        .filter(([key, value]) => key.startsWith('hunter_') && value)
        .map(([key]) => key.slice(7)),
    };
    if (artifact.key === 'enchant-amulet')
      values.storedMagic = Array.from({ length: artifact.slots }, (_, i) => ({
        key: form[`spell_${i}`],
        power: magicInfo(form[`spell_${i}`]).cost.min || 0.5,
      }));
    return runCommand('magicArtifactConfigure', { actorUuid: actor.uuid, itemId: item.id, values });
  }
  if (action === 'cast') {
    const grant = rows(actor.items).find(
      (row) =>
        row.flags?.[SYSTEM_ID]?.magicAmulet?.amuletId === item.id &&
        row.flags[SYSTEM_ID].magicAmulet.key === key
    );
    if (!grant) throw new RuleError('The amulet’s granted spell is missing; synchronize this item first.');
    const { castMagic } = await import('./magic-ui.js');
    return castMagic(actor, grant);
  }
  if (action === 'trophy') {
    let resistance;
    if (ritualArtifact(item).species === 'frightener') {
      const choice = await prompt(
        'Frightener trophy',
        input('resistance', 'Today’s damage resistance', {
          options: { slashing: 'Slashing', piercing: 'Piercing', bludgeoning: 'Bludgeoning' },
        }),
        { button: 'Attune' }
      );
      if (!choice) return;
      resistance = choice.resistance;
    }
    return runCommand('magicTrophyAttune', { actorUuid: actor.uuid, itemId: item.id, resistance });
  }
  const token = await selectedToken(actor);
  if (!token) return;
  const payload = { actorUuid: actor.uuid, itemId: item.id, tokenUuid: token.uuid };
  if (action === 'activate') return runCommand('magicSkullActivate', payload);
  if (action === 'retrieve') return runCommand('magicSkullRetrieve', payload);
  if (action === 'command') {
    const values = await prompt('Mental command', input('order', 'Command', { type: 'text' }), {
      button: 'Command animal',
    });
    if (values) return runCommand('magicSkullCommand', { ...payload, order: values.order });
    return;
  }
  if (action === 'burst') {
    if (!game.user.isGM) throw new RuleError('The GM chooses this hex burst.');
    const values = await prompt(
      'Pendant hex burst',
      '<p>Choose the hexes afflicting the wearer and every creature within2m.</p>' +
        MAGIC.filter((magic) => magic.kind === 'hex')
          .map((magic) => input(`hex_${magic.key}`, magic.name, { type: 'checkbox' }))
          .join(''),
      { button: 'Apply hexes' }
    );
    if (values)
      return runCommand('magicPendantBurst', {
        ...payload,
        hexKeys: Object.entries(values)
          .filter(([key, value]) => key.startsWith('hex_') && value)
          .map(([key]) => key.slice(4)),
      });
    return;
  }
  throw new RuleError('Unknown artifact action.');
}

export async function tickMagicGear() {
  for (const actor of actors()) {
    for (const item of actor.items)
      if (ritualArtifact(item)?.key === 'wagerers-pendant') await expirePendant(actor, item);
    if (actor.flags?.[SYSTEM_ID]?.crystalSkull) await skullDied(actor);
    await synchronizeMagicGear(actor);
  }
}
export function registerMagicGear(configuration = {}) {
  services = configuration;
  registerAmuletCrafting(configuration);
  registerCommand('magicSkullActivate', activateSkull);
  registerCommand('magicSkullCommand', commandSkull);
  registerCommand('magicSkullRetrieve', retrieveSkull);
  registerCommand('magicTrophyAttune', attuneTrophy);
  registerCommand('magicPendantBurst', pendantBurst);
  registerCommand('magicArtifactConfigure', configureArtifact);
  const schedule = () => {
    if (isPrimaryActiveGm()) serial('witcher-authority', tickMagicGear).catch(errorNotice);
  };
  for (const name of ['createItem', 'updateItem', 'deleteItem'])
    Hooks.on(name, (item, changes, options = {}) => {
      if (options.witcherMagicGear || changes?.witcherMagicGear) return;
      if (item.parent?.documentName === 'Actor') schedule();
    });
  Hooks.on('updateActor', (_actor, changes, options = {}) => {
    if (
      !options.witcherMagicGear &&
      (changes.system?.conditions ||
        changes['system.conditions'] ||
        changes.system?.effects ||
        changes['system.effects'])
    )
      schedule();
  });
  Hooks.on('updateWorldTime', schedule);
  Hooks.on('updateCombat', schedule);
  Hooks.on('renderChatMessageHTML', (message, html) =>
    html.querySelectorAll('[data-magic-gear]').forEach((button) => {
      if (button.dataset.magicGear === 'burst') button.hidden = !game.user.isGM;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const actor = await resolveFoundryUuid(
            button.dataset.actor ?? message.flags?.[SYSTEM_ID]?.actorUuid
          );
          await magicGearAction(
            actor,
            actor.items.get(button.dataset.item ?? message.flags?.[SYSTEM_ID]?.itemId),
            button.dataset.magicGear
          );
        } catch (error) {
          errorNotice(error);
        } finally {
          button.disabled = false;
        }
      });
    })
  );
  schedule();
}
