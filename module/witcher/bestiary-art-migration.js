import { isPrimaryActiveGm } from '../foundry-compat.js';

const SYSTEM = 'witcher-rilerena';
const CORE_SOURCE = 'The Witcher Core Rulebook v1.35';
const SOURCE_UUID = /^Compendium\.witcher-rilerena\.bestiary\.(?:Actor\.)?([a-zA-Z0-9]{16})$/;
const DEFAULT_IMAGES = new Set(['', 'icons/svg/mystery-man.svg', 'icons/svg/pawprint.svg']);
const isDefaultImage = (value) => value == null || DEFAULT_IMAGES.has(value);
const source = (document) => document?._source ?? document;
const contents = (collection) => collection?.contents ?? collection ?? [];
let pending;

function report(skipped = null) {
  return {
    skipped,
    actorsScanned: 0,
    scenesScanned: 0,
    tokensScanned: 0,
    actorsUpdated: 0,
    actorPortraitsUpdated: 0,
    prototypeTokensUpdated: 0,
    tokensUpdated: 0,
    tokenTexturesUpdated: 0,
    syntheticPortraitsUpdated: 0,
    errors: [],
  };
}

function artForActor(actor, catalog) {
  const data = source(actor);
  if (!data || !['npc', 'monster'].includes(data.type)) return null;
  // Provenance survives renaming imported creatures. A different or unknown
  // explicit source must not be reclassified merely because the name matches.
  const uuid = data._stats?.compendiumSource || data.flags?.core?.sourceId;
  if (uuid) return catalog[SOURCE_UUID.exec(uuid)?.[1]] ?? null;

  // Early imports could omit core provenance. Require our importer marker,
  // exact book identifier, a consistent printed/PDF page, and an exact name.
  const pages = data.flags?.[SYSTEM]?.sourcePages;
  if (
    data.system?.source !== CORE_SOURCE ||
    !Array.isArray(pages) ||
    !pages.length ||
    !pages.every((page) => Number.isInteger(page) && page > 0) ||
    !Number.isInteger(data.system.page) ||
    !pages.includes(data.system.page + 1)
  )
    return null;
  const matches = Object.values(catalog).filter((entry) => entry.name === data.name);
  return matches.length === 1 ? matches[0] : null;
}

async function migrate(catalog) {
  const result = report();
  const stillPrimary = () => {
    if (isPrimaryActiveGm()) return true;
    result.skipped = 'lost-primary-gm';
    return false;
  };
  const recordError = (document, error) => {
    result.errors.push({
      uuid: document.uuid ?? document.id,
      name: document.name ?? '',
      message: error?.message ?? String(error),
    });
  };

  for (const actor of contents(game.actors)) {
    if (!stillPrimary()) return result;
    result.actorsScanned++;
    try {
      const art = artForActor(actor, catalog);
      if (!art) continue;
      const data = source(actor),
        changes = {};
      if (isDefaultImage(data.img)) changes.img = art.portrait;
      if (isDefaultImage(data.prototypeToken?.texture?.src))
        changes['prototypeToken.texture.src'] = art.token;
      if (!Object.keys(changes).length) continue;
      const updated = await actor.update(changes);
      if (!updated) throw new Error('Actor image update was cancelled.');
      result.actorsUpdated++;
      if ('img' in changes) result.actorPortraitsUpdated++;
      if ('prototypeToken.texture.src' in changes) result.prototypeTokensUpdated++;
    } catch (error) {
      recordError(actor, error);
    }
  }

  // Scene documents include inactive scenes; canvas placeables would miss them.
  for (const scene of contents(game.scenes)) {
    if (!stillPrimary()) return result;
    result.scenesScanned++;
    for (const token of contents(scene.tokens)) {
      if (!stillPrimary()) return result;
      result.tokensScanned++;
      try {
        const baseActor = token.baseActor ?? game.actors.get(token.actorId),
          actor = token.actor ?? baseActor,
          art = artForActor(actor, catalog);
        if (!art) continue;
        const data = source(token),
          changes = {};
        if (isDefaultImage(data.texture?.src)) changes['texture.src'] = art.token;
        if (!token.actorLink && actor && isDefaultImage(source(actor).img)) {
          // V14 ActorDelta omits optional null fields when applying the delta.
          // Clear an old default portrait override so the synthetic Actor inherits
          // the current world portrait (including the GM's own custom portrait).
          // If that world update failed, a portrait delta can still fix this token.
          changes['delta.img'] = isDefaultImage(source(baseActor)?.img) ? art.portrait : null;
        }
        if (!Object.keys(changes).length) continue;
        const updated = await token.update(changes);
        if (!updated) throw new Error('Token image update was cancelled.');
        result.tokensUpdated++;
        if ('texture.src' in changes) result.tokenTexturesUpdated++;
        if ('delta.img' in changes) result.syntheticPortraitsUpdated++;
      } catch (error) {
        recordError(token, error);
      }
    }
  }
  return result;
}

/** Replace placeholder art on identified bestiary imports only.
 * Call on ready, and expose for explicit retries. No completion flag is stored:
 * each document remains retryable after cancellation, failure, or later import.
 * Only the elected active GM writes, and overlapping calls share one scan.
 */
export async function updateBestiaryArt(catalog) {
  if (!isPrimaryActiveGm()) return report('not-primary-gm');
  if (pending) return pending;
  pending = migrate(catalog);
  try {
    return await pending;
  } finally {
    pending = null;
  }
}
