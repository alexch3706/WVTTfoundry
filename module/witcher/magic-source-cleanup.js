/** Source cleanup shared by explicit Dispel and the automatic upkeep clock. */
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { removeMagicEffects } from './magic-state.js';
import { endWorldItemCast } from './magic-world-runtime.js';
import { commitActor } from './runtime.js';

const copy = (value) => structuredClone(value);
const rows = (collection) => Array.from(collection?.values?.() ?? collection ?? []);
const actors = () => [
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

async function commitAll(plans, after, index = 0) {
  if (index === plans.length) return after?.();
  const plan = plans[index];
  return commitActor(plan.actor, plan.changes, [], () => commitAll(plans, after, index + 1));
}

/** The returned rollback also restores Regions under their original IDs. It lets
 * the clock compensate several expired casts and ordinary healing as one operation.
 */
export async function endMagicSource(castId, { after, collapse = false, returnTransaction = false } = {}) {
  const plans = [];
  for (const actor of actors()) {
    const selected = actor.system.effects.filter(
      (effect) => effect.magic?.castId === castId && !effect.magic.persistsAfterSource
    );
    if (!selected.length) continue;
    if (
      actor.flags?.[SYSTEM_ID]?.artifactCompression?.active &&
      selected.some((effect) => effect.magic?.key === 'artifact-compression')
    )
      throw new RuleError(
        'Reverse Artifact Compression from its original ritual card so the GM records HP restoration and the actual body is restored. Generic removal cannot reverse this ritual.'
      );
    const activeShield = selected.find(
      (effect) => effect.magic.key === 'active-shield' && !effect.magic.collapseResolved
    );
    let changes;
    if (activeShield && !collapse) {
      const effects = copy(actor.system.effects),
        shield = effects.find((effect) => effect.id === activeShield.id);
      shield.shieldHP = 0;
      shield.magic.pendingCollapse = true;
      shield.magic.maintenance = 'none';
      changes = { 'system.effects': effects };
    } else {
      const removed = removeMagicEffects(
        actor.system,
        (effect) => effect.magic?.castId === castId && !effect.magic.persistsAfterSource
      );
      changes = { 'system.effects': removed.effects, 'system.conditions': removed.conditions };
    }
    plans.push({ actor, changes, before: copy(actor._source.system) });
  }
  const regions = [];
  for (const scene of rows(game.scenes))
    for (const region of rows(scene.regions)) {
      const keys = ['magicArea', 'ritualArea'].filter(
        (key) => region.flags?.[SYSTEM_ID]?.[key]?.castId === castId
      );
      if (keys.length)
        regions.push({ region, scene, keys, source: { ...region.toObject(), _id: region.id } });
    }
  let worldUndo,
    actorChangesCommitted = false;
  const restoreRegions = async () => {
    for (const entry of regions) {
      const current = rows(entry.scene.regions).find((region) => region.id === entry.region.id);
      if (!current)
        await entry.scene.createEmbeddedDocuments('Region', [copy(entry.source)], { keepId: true });
      else
        for (const key of entry.keys) {
          const previous = entry.source.flags?.[SYSTEM_ID]?.[key]?.active;
          const path = `flags.${SYSTEM_ID}.${key}.${previous === undefined ? '-=active' : 'active'}`;
          await current.update({ [path]: previous === undefined ? null : previous });
        }
    }
  };
  const rollback = async () => {
    await restoreRegions();
    await worldUndo?.rollback();
    for (const plan of [...plans].reverse())
      await plan.actor.update(
        { system: plan.before },
        { diff: false, recursive: false, witcherMagicRollback: true }
      );
  };
  try {
    worldUndo = await endWorldItemCast(castId);
    for (const { region, keys } of regions)
      await region.update(Object.fromEntries(keys.map((key) => [`flags.${SYSTEM_ID}.${key}.active`, false])));
    await commitAll(plans, async () => {
      await after?.();
      for (const { region } of regions) await region.delete();
    });
    actorChangesCommitted = true;
  } catch (error) {
    // commitAll already compensates actor fields if its callback fails.
    await restoreRegions();
    await worldUndo?.rollback();
    throw error;
  }
  if (returnTransaction)
    return {
      castId,
      actorUuids: plans.map((plan) => plan.actor.uuid),
      rollback: async () => {
        if (!actorChangesCommitted) return;
        await rollback();
        actorChangesCommitted = false;
      },
    };
}
