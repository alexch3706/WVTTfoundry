import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { chat, commitActor, errorNotice, escapeHTML as e, serial } from './runtime.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import { triggerMagicOngoingRegion, ongoingProcedureSurvivesExpiry } from './magic-ongoing.js';
import {
  magicRegionState,
  magicRegionTargets,
  magicSceneScale,
  registerMagicRegionBehavior,
  updateMagicRegion,
} from './magic-regions.js';

const values = (collection) => collection?.contents ?? Array.from(collection ?? []);
const now = () => Number(game.time?.worldTime ?? 0);
const documentToken = (token) => token?.document ?? token;
const tokenState = (token) => token?._source ?? token;
const byId = (collection, id) => collection?.get?.(id) ?? values(collection).find((value) => value.id === id);

function requireAuthority() {
  if (!isPrimaryActiveGm()) throw new RuleError('Only the elected GM resolves persistent magic zones.');
}

export function activeMagicZone(region, time = now()) {
  const state = magicRegionState(region);
  return (
    !!state &&
    state.active !== false &&
    !(Number.isFinite(state.expires) && state.expires > 0 && state.expires <= time)
  );
}

function allScenes(scenes) {
  return [...new Map([...values(game.scenes), ...values(scenes)].map((scene) => [scene.id, scene])).values()];
}
function allRegions(scenes) {
  return scenes.flatMap((scene) => values(scene.regions));
}

function zoneCandidates(region) {
  const state = magicRegionState(region);
  if (!state?.spec || !state.origin || !state.placement)
    throw new RuleError('This magic zone is missing its saved geometry.');
  // Native V14 retains wall-constrained polygons on saved Regions. Recompute on a
  // viewed level; elsewhere use the persisted constraints rather than empty previews.
  if (region.restriction?.enabled && region.parent.levels?.get(state.origin.level)?.isView)
    region.updateShapeConstraints({ save: false });
  const candidates = magicRegionTargets({
    region,
    casterToken: byId(region.parent.tokens, state.casterTokenId),
    spec: state.spec,
    origin: state.origin,
    placement: state.placement,
    requester: game.user,
  });
  // The override is a ruling for the original cast, not a permanent teleporting
  // attachment: ongoing entry/exit follows the current native Region geometry.
  return candidates.filter((candidate) => candidate.included);
}

function yrdenEffect(region, actor, tokenIds, existing) {
  const state = magicRegionState(region);
  const penalty = Number(state.penalty);
  if (!Number.isInteger(penalty) || penalty < 1 || penalty > 4)
    throw new RuleError('Yrden must have a saved REF/SPD penalty from 1 to 4.');
  return {
    ...existing,
    id: existing?.id ?? `yrden:${region.uuid}`,
    key: 'Yrden',
    sourceUuid: state.casterUuid,
    expires: state.expires ?? 0,
    modifiers: { ref: -penalty, spd: -penalty },
    magic: {
      ...existing?.magic,
      key: 'yrden-zone',
      regionUuid: region.uuid,
      castId: state.castId,
      casterUuid: state.casterUuid,
      targetActorUuid: actor.uuid,
      tokenIds: [...new Set(tokenIds)].sort(),
      penalty,
      suppressedOverlap: false,
    },
    notes: 'Yrden: REF/SPD penalty while inside the circle; incorporeal creatures become corporeal.',
  };
}

async function applyActorPlans(plans, index = 0) {
  if (index === plans.length) return;
  const { actor, effects } = plans[index];
  return commitActor(actor, { 'system.effects': effects }, [], () => applyActorPlans(plans, index + 1));
}

/**
 * Reconcile all source-linked zone effects, including linked/synthetic actors.
 * UNSERIALIZED: call directly from an existing authority command; hooks queue it.
 */
export async function refreshMagicZones({ scenes } = {}) {
  requireAuthority();
  const sceneList = allScenes(scenes),
    regions = allRegions(sceneList);
  const actors = new Map(values(game.actors).map((actor) => [actor.uuid, actor]));
  for (const scene of sceneList)
    for (const token of values(scene.tokens)) if (token.actor) actors.set(token.actor.uuid, token.actor);
  const live = new Map(
    regions.filter((region) => activeMagicZone(region)).map((region) => [region.uuid, region])
  );
  const desired = new Map();
  for (const region of live.values()) {
    if (magicRegionState(region).key !== 'yrden') continue;
    const occupants = new Map();
    for (const candidate of zoneCandidates(region)) {
      const token = byId(region.parent.tokens, candidate.tokenId),
        actor = token?.actor;
      if (!actor) continue;
      if (!occupants.has(actor.uuid)) occupants.set(actor.uuid, { actor, tokenIds: [] });
      occupants.get(actor.uuid).tokenIds.push(token.id);
    }
    for (const { actor, tokenIds } of occupants.values()) {
      if (!desired.has(actor.uuid)) desired.set(actor.uuid, []);
      const existing = actor.system.effects.find(
        (effect) => effect.magic?.key === 'yrden-zone' && effect.magic.regionUuid === region.uuid
      );
      desired.get(actor.uuid).push(yrdenEffect(region, actor, tokenIds, existing));
    }
  }
  const plans = [];
  for (const actor of actors.values()) {
    const sources = (desired.get(actor.uuid) ?? []).sort(
      (a, b) => b.magic.penalty - a.magic.penalty || a.magic.regionUuid.localeCompare(b.magic.regionUuid)
    );
    // Table convention: overlapping copies retain every source, but only the
    // strongest penalty applies. Removal immediately promotes the next source.
    for (const effect of sources.slice(1)) {
      effect.modifiers = {};
      effect.magic.suppressedOverlap = true;
      effect.notes += ' A stronger or equal overlapping Yrden supplies the current penalty.';
    }
    const current = actor.system.effects;
    const kept = current.filter((effect) => {
      if (effect.magic?.key === 'yrden-zone') return false;
      if (effect.magic?.casterEffect && effect.magic.regionUuid && !live.has(effect.magic.regionUuid))
        return false;
      return true;
    });
    const effects = [...kept, ...sources];
    if (JSON.stringify(effects) !== JSON.stringify(current)) plans.push({ actor, effects });
  }
  await applyActorPlans(plans);
  return { updatedActors: plans.map(({ actor }) => actor.uuid), activeRegions: [...live.keys()] };
}

function controllingActor(actor, scenes, visited = new Set()) {
  if (!actor || visited.has(actor.uuid)) return actor;
  visited.add(actor.uuid);
  const puppet = actor.system.effects.find(
    (effect) => effect.magic?.controlled && (!effect.expires || effect.expires > now())
  );
  const uuid = puppet?.magic?.casterUuid;
  if (!uuid || uuid === actor.uuid) return actor;
  const controller =
    values(game.actors).find((candidate) => candidate.uuid === uuid) ??
    scenes.flatMap((scene) => values(scene.tokens)).find((token) => token.actor?.uuid === uuid)?.actor;
  return controller ? controllingActor(controller, scenes, visited) : actor;
}

function allegiance(token, caster, sceneList) {
  if (token.actor?.uuid === caster.actor?.uuid) return 'ally';
  const controller = controllingActor(token.actor, sceneList),
    casterController = controllingActor(caster.actor, sceneList);
  if (controller?.uuid === casterController?.uuid) return 'ally';
  const effectiveDisposition = (document, actor) => {
    if (actor?.uuid === document.actor?.uuid)
      return Number(document.disposition ?? tokenState(document).disposition);
    const tokens = sceneList
      .flatMap((scene) => values(scene.tokens))
      .filter((other) => other.actor?.uuid === actor?.uuid);
    const dispositions = [
      ...new Set(tokens.map((other) => Number(other.disposition ?? tokenState(other).disposition))),
    ];
    return dispositions.length === 1 ? dispositions[0] : 0;
  };
  const a = effectiveDisposition(token, controller),
    b = effectiveDisposition(caster, casterController);
  if (![1, -1].includes(a) || ![1, -1].includes(b)) return 'unknown';
  return a === b ? 'ally' : 'hostile';
}

function trapDistance(region, token) {
  const state = magicRegionState(region),
    scale = magicSceneScale(region.parent, state.spec);
  const source = tokenState(token),
    size = token.getSize(source);
  const dx = Math.max(source.x - state.placement.x, state.placement.x - source.x - size.width, 0);
  const dy = Math.max(source.y - state.placement.y, state.placement.y - source.y - size.height, 0);
  const bottom = source.elevation * scale.metresPerUnit;
  const top = bottom + (source.depth ?? 0) * region.parent.grid.distance * scale.metresPerUnit;
  const elevation = state.origin.elevation * scale.metresPerUnit;
  const dz = Math.max(bottom - elevation, elevation - top, 0);
  return Math.hypot(dx / scale.pixelsPerMetre, dy / scale.pixelsPerMetre, dz);
}

/** Candidate metadata for a GM choice; hidden creatures must not be broadcast to players. */
export function trapCandidates(region) {
  const state = magicRegionState(region);
  if (state?.key !== 'magic-trap') throw new RuleError('Choose a Magic Trap region.');
  if (!activeMagicZone(region)) throw new RuleError('This Magic Trap has ended.');
  const caster = byId(region.parent.tokens, state.casterTokenId);
  if (!caster?.actor || caster.actor.uuid !== state.casterUuid)
    throw new RuleError('The trap’s caster token no longer identifies its caster.');
  const scenes = allScenes();
  return zoneCandidates(region)
    .map((candidate) => {
      const token = byId(region.parent.tokens, candidate.tokenId);
      return {
        token,
        tokenUuid: token.uuid,
        name: token.name,
        distance: trapDistance(region, token),
        allegiance: allegiance(token, caster, scenes),
      };
    })
    .filter(
      (candidate) =>
        candidate.allegiance !== 'ally' && !candidate.token.actor.system.conditions?.includes('dead')
    )
    .sort((a, b) => a.distance - b.distance || a.token.id.localeCompare(b.token.id));
}

/** Revalidate the closest hostile at attack time, respecting current movement and Puppet allegiance. */
export function trapTarget(region, requestedToken, { user = game.user } = {}) {
  const state = magicRegionState(region);
  if (!state?.prepared && !(Number.isFinite(state?.preparedAt) && now() >= state.preparedAt))
    throw new RuleError('Magic Trap is still completing its preparation round.');
  const candidates = trapCandidates(region);
  const hostile = candidates.find((candidate) => candidate.allegiance === 'hostile');
  if (requestedToken) {
    const requested = documentToken(requestedToken);
    const selected = candidates.find(
      (candidate) =>
        candidate.token === requested || candidate.token.id === requested || candidate.tokenUuid === requested
    );
    if (!selected) throw new RuleError('The selected creature is outside the trap or is an ally.');
    const needsRuling =
      selected.allegiance === 'unknown' ||
      candidates.some(
        (candidate) => candidate.allegiance === 'unknown' && candidate.distance <= selected.distance + 1e-8
      );
    if (needsRuling && !user?.isGM)
      throw new RuleError('The GM must identify enemies with neutral or unknown disposition.');
    if (hostile && selected.distance > hostile.distance + 1e-8)
      throw new RuleError('Magic Trap must attack the closest enemy.');
    return selected.token;
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.allegiance === 'unknown' && (!hostile || candidate.distance <= hostile.distance + 1e-8)
    )
  ) {
    const error = new RuleError(
      'The GM must choose the trap’s enemy: a closer creature has neutral or unknown disposition.'
    );
    error.trapCandidates = candidates;
    throw error;
  }
  return hostile?.token ?? null;
}

function trapCycle(region, combat) {
  const state = magicRegionState(region);
  if (!state.prepared || !activeMagicZone(region)) return null;
  if (combat?.started) {
    const sceneId = combat.scene?.id ?? combat.sceneId;
    if (sceneId && sceneId !== region.parent.id) return null;
    if (state.castCombat?.id === combat.id && combat.round <= state.castCombat.round) return null;
    const casterCombatant = values(combat.combatants).find(
      (combatant) => (combatant.tokenId ?? combatant.token?.id) === state.casterTokenId
    );
    if (casterCombatant ? combat.combatant?.id !== casterCombatant.id : combat.turn !== 0) return null;
    return `${combat.id}:${combat.round}`;
  }
  if (!Number.isFinite(state.preparedAt)) return null;
  return `time:${Math.floor((now() - state.preparedAt) / 3)}`;
}

export { trapCycle as magicTrapCycle };

async function trapPrompt(region, cycle) {
  const state = magicRegionState(region);
  if (state.lastAttack?.cycle === cycle) return null;
  const caster = byId(region.parent.tokens, state.casterTokenId)?.actor;
  if (!caster) return null;
  let target = null,
    needsGMTarget = false;
  try {
    target = trapTarget(region);
  } catch (error) {
    if (!error.trapCandidates) throw error;
    needsGMTarget = true;
  }
  if (!target && !needsGMTarget) return null;
  // Recover a prompt whose chat creation succeeded but receipt persistence was interrupted.
  const existing = values(game.messages).find((message) => {
    const flags = message.flags?.[SYSTEM_ID];
    return flags?.kind === 'magic-trap-ready' && flags.regionUuid === region.uuid && flags.cycle === cycle;
  });
  if (existing) {
    await updateMagicRegion(region, {
      lastAttack: { cycle, messageUuid: existing.uuid, used: !!existing.flags[SYSTEM_ID].attackUsed },
    });
    return existing;
  }
  const flags = {
    kind: 'magic-trap-ready',
    regionUuid: region.uuid,
    castId: state.castId,
    casterUuid: caster.uuid,
    cycle,
    targetTokenUuid: target?.uuid ?? '',
    needsGMTarget,
    attackUsed: false,
  };
  const gmIds = values(game.users)
    .filter((user) => user.active && user.isGM)
    .map((user) => user.id);
  const message = await chat(
    caster,
    'Magic Trap · round attack',
    `<p>${needsGMTarget ? 'Choose the closest enemy after reviewing neutral or unknown dispositions.' : `Closest enemy: ${e(target.name)}.`}</p>` +
      `<button type="button" data-magic-action="trap" data-region="${e(region.uuid)}">Magic Trap attack</button>`,
    { flags, whisper: gmIds }
  );
  try {
    await updateMagicRegion(region, { lastAttack: { cycle, messageUuid: message.uuid, used: false } });
  } catch (error) {
    await message.delete();
    throw error;
  }
  return message;
}

/** Expire even empty zones, finish preparation, and offer one attack per trap round. UNSERIALIZED. */
export async function tickMagicZones({ scenes, combat = game.combat, attacks = true } = {}) {
  requireAuthority();
  const sceneList = allScenes(scenes),
    expired = [],
    prepared = [],
    prompts = [],
    failures = [];
  for (const region of allRegions(sceneList)) {
    try {
      const state = magicRegionState(region);
      if (!state) continue;
      if (state.operations?.length && state.active !== false) {
        const hasRound = state.operations.some((operation) =>
          ['startTurn', 'enterOrStartTurn', 'castAndEnterOnOwnTurnOrStartTurn'].includes(operation.timing)
        );
        if (hasRound) {
          const through = state.expires > 0 ? Math.min(now(), state.expires) : now();
          let at = Number.isFinite(state.nextAt) ? state.nextAt : state.createdAt + 3,
            count = 0;
          while (at <= through && count++ < 100) {
            for (const candidate of zoneCandidates(region)) {
              const token = byId(region.parent.tokens, candidate.tokenId);
              if (
                !token?.actor ||
                (combat?.started &&
                  values(combat.combatants).some((entry) => entry.actor?.uuid === token.actor.uuid))
              )
                continue;
              await triggerMagicOngoingRegion(
                region,
                {
                  name: 'tokenTimeRound',
                  data: {
                    token,
                    combat: { id: 'world', started: false },
                    round: Math.floor(at / 3),
                    turn: 0,
                  },
                },
                { time: at }
              );
            }
            at += 3;
            await region.update({ [`flags.${SYSTEM_ID}.magicArea.nextAt`]: at });
          }
          if (at <= through) continue;
        }
      }
      if (Number.isFinite(state.expires) && state.expires > 0 && state.expires <= now()) {
        const ongoing = region.flags?.[SYSTEM_ID]?.magicOngoing;
        if (
          state.operations?.length &&
          Object.values(ongoing?.pending ?? {}).some(ongoingProcedureSurvivesExpiry)
        ) {
          await region.update({
            [`flags.${SYSTEM_ID}.magicArea.active`]: false,
            [`flags.${SYSTEM_ID}.magicOngoing.phase`]: 'expired',
          });
          continue;
        }
        await region.delete();
        expired.push(region.uuid);
        continue;
      }
      if (state.key !== 'magic-trap' || !activeMagicZone(region)) continue;
      if (!state.prepared && Number.isFinite(state.preparedAt) && now() >= state.preparedAt) {
        await updateMagicRegion(region, { prepared: true });
        prepared.push(region.uuid);
      }
      if (!attacks) continue;
      const cycle = trapCycle(region, combat);
      if (!cycle) continue;
      const prompt = await trapPrompt(region, cycle);
      if (prompt) prompts.push(prompt.uuid);
    } catch (error) {
      failures.push(error);
    }
  }
  await refreshMagicZones({ scenes: sceneList });
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join(' '));
  return { expired, prepared, prompts };
}

/** Register at init. Native callbacks schedule work and return immediately to avoid nested queue deadlocks. */
export function registerMagicZones() {
  const schedule = (operation) => {
    if (!isPrimaryActiveGm()) return;
    serial('witcher-authority', operation).catch(errorNotice);
  };
  registerMagicRegionBehavior(
    (event) => {
      if (magicRegionState(event.region)?.operations?.length)
        schedule(() => triggerMagicOngoingRegion(event.region, event));
      if (['tokenEnter', 'tokenExit'].includes(event.name)) schedule(() => refreshMagicZones());
      else schedule(() => tickMagicZones());
    },
    { isAuthority: isPrimaryActiveGm }
  );
  Hooks.on('updateToken', () => schedule(() => refreshMagicZones()));
  Hooks.on('createToken', () => schedule(() => refreshMagicZones()));
  Hooks.on('deleteToken', () => schedule(() => refreshMagicZones()));
  Hooks.on('deleteRegion', (region) => {
    if (magicRegionState(region)) schedule(() => refreshMagicZones());
  });
  Hooks.on('updateRegion', (region, changes) => {
    if (
      magicRegionState(region) &&
      ['shapes', 'elevation', 'levels', 'restriction', '_shapeConstraints'].some((key) => key in changes)
    )
      schedule(() => refreshMagicZones());
  });
  Hooks.on('updateCombat', (combat, changes) => {
    if ('round' in changes || 'turn' in changes) schedule(() => tickMagicZones({ combat }));
  });
  Hooks.on('updateWorldTime', () => schedule(() => tickMagicZones()));
  Hooks.on('canvasReady', () => schedule(() => tickMagicZones()));
  Hooks.once('ready', () => schedule(() => tickMagicZones()));
}
