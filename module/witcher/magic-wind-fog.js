/** Source-aware native area modifiers and Zephyr's forced movement (Core 103–104, 171). */
import { SYSTEM_ID } from './config.js';
import { RuleError } from './rules.js';
import { mountedDamage } from './advanced-rules.js';
import { magicInfo } from './magic-catalog.js';
import { registerSpellExecutionAdapters } from './magic-execution.js';
import {
  createMagicRegion,
  magicRegionState,
  magicRegionTargets,
  magicSceneScale,
  magicTokenOrigin,
} from './magic-regions.js';
import { activeMagicZone } from './magic-zones.js';
import { isPrimaryActiveGm } from '../foundry-compat.js';
import { registerCommand, runCommand } from './authority.js';
import { chat, dice, prompt, input, serial, errorNotice, escapeHTML as e } from './runtime.js';

const copy = (value) => structuredClone(value);
const values = (collection) => collection?.contents ?? Array.from(collection ?? []);
const source = (document) => document.toObject?.() ?? copy(document._source ?? document);
const get = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const present = (object, path) => get(object, path) !== undefined;
const deletion = (path) => {
  const parts = path.split('.');
  parts[parts.length - 1] = `-=${parts.at(-1)}`;
  return parts.join('.');
};
const restored = (path, value) =>
  value === undefined ? { [deletion(path)]: null } : { [path]: copy(value) };
function inverse(document, changes) {
  const before = source(document),
    result = {};
  for (const path of Object.keys(changes)) {
    const normal = path.replace(/(^|\.)-=/g, '$1');
    Object.assign(result, restored(normal, get(before, normal)));
  }
  return result;
}
function requireGM(user = game.user) {
  if (!user?.isGM) throw new RuleError('The GM must resolve this magical world effect.');
}

/** V14 sight.range alone does not limit illuminated vision: lightPerception and every SIGHT detection mode must also be capped. */
export function fogVisionPlan(tokenSource, sources, limit, sightModes = ['lightPerception']) {
  const previous = tokenSource.flags?.[SYSTEM_ID]?.fogVision;
  const paths = new Set(Object.keys(previous?.fields ?? {}));
  const changes = {},
    fields = {};
  if (sources.length) {
    if (!(Number.isFinite(limit) && limit > 0))
      throw new RuleError('Fog vision requires a positive native scene distance.');
    paths.add('sight.range');
    for (const mode of new Set(['lightPerception', ...sightModes]))
      if (mode === 'lightPerception' || tokenSource.detectionModes?.[mode])
        paths.add(`detectionModes.${mode}.range`);
  }
  for (const path of paths) {
    const current = get(tokenSource, path),
      old = previous?.fields?.[path];
    // A module/user changing a constrained range establishes a new baseline.
    const baseline =
      old && same(current, old.applied)
        ? old.baseline
        : { exists: present(tokenSource, path), value: current ?? null };
    const mode = path.startsWith('detectionModes.') ? path.split('.')[1] : null;
    const modeAbsent =
      old && same(current, old.applied) ? old.modeAbsent : mode ? !tokenSource.detectionModes?.[mode] : false;
    if (!sources.length) {
      if (!old || !same(current, old.applied)) continue;
      if (modeAbsent && same(tokenSource.detectionModes?.[mode], { enabled: true, range: old.applied }))
        changes[deletion(`detectionModes.${mode}`)] = null;
      else Object.assign(changes, baseline.exists ? { [path]: baseline.value } : { [deletion(path)]: null });
      continue;
    }
    const raw = baseline.exists ? baseline.value : path === 'sight.range' ? 0 : null;
    const applied = raw === null || !Number.isFinite(raw) ? limit : Math.min(Math.max(0, raw), limit);
    fields[path] = { baseline, applied, modeAbsent };
    if (modeAbsent && !tokenSource.detectionModes?.[mode])
      changes[`detectionModes.${mode}`] = { enabled: true, range: applied };
    else if (!same(current, applied)) changes[path] = applied;
  }
  if (sources.length) {
    const next = { sources: [...new Set(sources)].sort(), limit, fields };
    if (!same(previous, next)) changes[`flags.${SYSTEM_ID}.fogVision`] = next;
  } else if (previous) changes[`flags.${SYSTEM_ID}.-=fogVision`] = null;
  return changes;
}

const environmentRules = new Set(['cleanAir', 'breathableAir', 'weatherProtection']);
export function modifierZoneSupported(operation) {
  return (
    operation.type === 'zone' &&
    operation.shape?.shape === 'circle' &&
    operation.operations?.length > 0 &&
    operation.operations.every(
      (child) =>
        child.type === 'modifier' &&
        child.target === 'occupants' &&
        (!child.timing || child.timing === 'immediate') &&
        !child.save &&
        !child.predicate &&
        (environmentRules.has(child.rule?.key) ||
          (child.visionRange === 4 && child.modifiers?.awareness === -3 && !child.rule))
    ) &&
    // Moving caster-centred zones require a recorded interpretation. A placed Air Pocket is stationary.
    (!operation.centeredOnCaster || typeof operation.followCaster === 'boolean')
  );
}
export const dormynFogSupported = modifierZoneSupported;

function allScenes(scenes) {
  return [...new Map([...values(game.scenes), ...values(scenes)].map((scene) => [scene.id, scene])).values()];
}
function candidates(region) {
  const state = magicRegionState(region),
    caster = region.parent.tokens.get(state.casterTokenId);
  const origin = state.followCaster && caster ? magicTokenOrigin(caster) : state.origin;
  if (region.restriction?.enabled && region.parent.levels?.get(origin.level)?.isView)
    region.updateShapeConstraints({ save: false });
  return magicRegionTargets({
    region,
    casterToken: caster,
    spec: state.spec,
    origin,
    placement: state.placement,
    requester: game.user,
  }).filter((row) => row.included);
}
function zoneEffect(region, actor, tokenIds, child, index, enabled) {
  const state = magicRegionState(region);
  return {
    id: `modifier-zone:${region.id}:${index}`,
    key: region.name,
    sourceUuid: state.casterUuid,
    expires: state.expires ?? 0,
    modifiers: enabled ? copy(child.modifiers ?? {}) : {},
    magic: {
      key: 'modifier-zone',
      regionUuid: region.uuid,
      castId: state.castId,
      casterUuid: state.casterUuid,
      tokenIds,
      operation: { ...copy(child), target: 'target', modifiers: enabled ? copy(child.modifiers ?? {}) : {} },
      suppressedOverlap: !enabled,
    },
    notes: `${state.zoneConvention} ${child.visionRange ? 'Awareness −3; sight limited to 4m, including the caster and allies. Identical overlapping fog penalties apply once (table convention).' : ''}`,
  };
}

/** Unsynchronized: call inside an authority transaction. Returns an inverse for cast failure compensation. */
export async function refreshModifierZones({ scenes } = {}) {
  if (!isPrimaryActiveGm()) throw new RuleError('Only the elected GM reconciles magical areas.');
  const sceneList = allScenes(scenes),
    actorMap = new Map(values(game.actors).map((actor) => [actor.uuid, actor]));
  const desired = new Map(),
    tokenFog = new Map(),
    undo = [];
  for (const scene of sceneList)
    for (const token of values(scene.tokens)) if (token.actor) actorMap.set(token.actor.uuid, token.actor);
  for (const scene of sceneList)
    for (const region of values(scene.regions)) {
      const state = magicRegionState(region);
      if (!state?.modifierZone || !activeMagicZone(region)) continue;
      const groups = new Map();
      for (const row of candidates(region)) {
        const token = scene.tokens.get(row.tokenId);
        if (!token?.actor) continue;
        const group = groups.get(token.actor.uuid) ?? { actor: token.actor, tokenIds: [] };
        group.tokenIds.push(token.id);
        groups.set(token.actor.uuid, group);
        const vision = state.operations.map((child) => child.visionRange).filter((distance) => distance > 0);
        if (vision.length) {
          const record = tokenFog.get(token.uuid) ?? { sources: [], limit: Infinity };
          record.sources.push(region.uuid);
          record.limit = Math.min(
            record.limit,
            ...vision.map((distance) => distance / magicSceneScale(scene, state.spec).metresPerUnit)
          );
          tokenFog.set(token.uuid, record);
        }
      }
      for (const { actor, tokenIds } of groups.values()) {
        const effects = desired.get(actor.uuid) ?? [];
        for (const [index, child] of state.operations.entries())
          effects.push({ region, tokenIds: tokenIds.sort(), child, index });
        desired.set(actor.uuid, effects);
      }
    }
  try {
    const sightModes = Object.entries(globalThis.CONFIG?.Canvas?.detectionModes ?? {})
      .filter(([, mode]) => mode.type === 0)
      .map(([id]) => id);
    for (const scene of sceneList)
      for (const token of values(scene.tokens)) {
        const fog = tokenFog.get(token.uuid),
          changes = fogVisionPlan(source(token), fog?.sources ?? [], fog?.limit ?? 4, sightModes);
        if (Object.keys(changes).length) {
          const before = inverse(token, changes);
          await token.update(changes, { witcherModifierZone: true });
          undo.push(() => token.update(before, { witcherModifierZone: true }));
        }
      }
    for (const actor of actorMap.values()) {
      const wanted = (desired.get(actor.uuid) ?? []).sort((a, b) =>
        a.region.uuid.localeCompare(b.region.uuid)
      );
      let hasFog = false;
      const effects = actor.system.effects.filter((effect) => effect.magic?.key !== 'modifier-zone');
      for (const row of wanted) {
        const fog = row.child.visionRange === 4;
        effects.push(zoneEffect(row.region, actor, row.tokenIds, row.child, row.index, !fog || !hasFog));
        if (fog) hasFog = true;
      }
      if (!same(effects, actor.system.effects)) {
        const before = copy(actor.system.effects);
        await actor.update({ 'system.effects': effects }, { witcherModifierZone: true });
        undo.push(() => actor.update({ 'system.effects': before }, { witcherModifierZone: true }));
      }
    }
  } catch (error) {
    for (const restore of undo.reverse()) await restore();
    throw error;
  }
  return {
    rollback: async () => {
      for (const restore of [...undo].reverse()) await restore();
    },
  };
}

export async function createModifierZone(operation, { data, caster, sourceToken, operationIndex }) {
  requireGM();
  if (!modifierZoneSupported(operation))
    throw new RuleError('This modifier area has no supported entry/exit procedure.');
  const existing = values(sourceToken.parent.regions).find((region) => {
    const state = magicRegionState(region);
    return state?.castId === data.castId && state.operationIndex === operationIndex && state.modifierZone;
  });
  if (existing)
    return { status: 'applied', receipt: { regionUuid: existing.uuid }, rollback: async () => {} };
  const origin = magicTokenOrigin(sourceToken),
    followCaster = !!operation.followCaster;
  const spec = {
    ...operation.shape,
    origin: operation.centeredOnCaster ? 'caster' : 'ranged',
    range: data.magic.range.distance,
    volume: 'level',
    wallRestriction: 'sight',
    includeCaster: true,
  };
  const placement = operation.centeredOnCaster ? origin : data.area?.placement;
  const zoneConvention = operation.centeredOnCaster
    ? `Table area convention: ${followCaster ? 'follows the caster' : 'stays at its initial position'}. The book does not specify movement after casting.`
    : 'Area remains at its placed position.';
  const duration = operation.duration ?? data.magic.duration;
  const seconds = duration?.seconds || (duration?.rounds ?? 0) * 3;
  const region = await createMagicRegion({
    scene: sourceToken.parent,
    casterToken: sourceToken,
    spec,
    placement,
    expectedOrigin: origin,
    requester: game.user,
    name: data.name,
    color: '#a5b7c8',
    links: {
      castId: data.castId,
      casterUuid: caster.uuid,
      spellUuid: data.itemUuid || `${caster.uuid}.Item.${data.itemId}`,
    },
    rounds: Math.max(1, duration?.rounds ?? (seconds ? Math.ceil(seconds / 3) : 1)),
    state: {
      key: data.magicKey,
      modifierZone: true,
      operationIndex,
      operations: copy(operation.operations),
      followCaster,
      zoneConvention,
      expires: seconds ? game.time.worldTime + seconds : 0,
      active: true,
      tokenUuid: sourceToken.uuid,
      messageUuid: data.messageUuid,
      createdAt: game.time.worldTime,
    },
    validatedCast:
      !followCaster &&
      data.area?.data &&
      ['shape', 'radius', 'distance', 'width', 'height', 'verticalHeight'].every(
        (key) =>
          operation.shape[key] === undefined ||
          operation.shape[key] === (data.area.spec ?? data.area.area)?.[key]
      )
        ? { ...data.area, area: data.area.spec ?? data.area.area }
        : undefined,
  });
  let reconciled;
  try {
    // Native V14 Region attachment translates shapes/levels with the Token; no polling emulation.
    if (followCaster)
      await region.update({ 'attachment.token': sourceToken.id, hidden: !!sourceToken.hidden });
    return {
      status: 'applied',
      receipt: { regionUuid: region.uuid, zoneConvention },
      afterCommit: async () => {
        reconciled = await refreshModifierZones({ scenes: [sourceToken.parent] });
      },
      rollback: async () => {
        if (reconciled) await reconciled.rollback();
        await region.delete();
      },
    };
  } catch (error) {
    await region.delete();
    throw error;
  }
}
export const createDormynFog = createModifierZone;

export function windMoveSupported(operation) {
  return (
    operation.type === 'move' &&
    operation.mode === 'push' &&
    operation.collision === 'ramming' &&
    operation.unit === 'm' &&
    Number.isFinite(operation.distance) &&
    operation.distance >= 0 &&
    ['awayFromCaster', undefined].includes(operation.direction) &&
    (!operation.timing || operation.timing === 'immediate') &&
    !operation.save
  );
}

/** Native wall sweep and solid token bounds, retaining actual distance travelled for collision damage. */
export function windPushPlan(sourceToken, token, metres) {
  if (!token || token.parent !== sourceToken.parent)
    throw new RuleError('The pushed token must remain on the caster’s scene.');
  if (token.uuid === sourceToken.uuid) return { distance: 0, changes: {}, self: true, collision: null };
  const scene = token.parent,
    scale = magicSceneScale(scene),
    start = magicTokenOrigin(token),
    origin = magicTokenOrigin(sourceToken);
  if (globalThis.canvas?.scene?.id !== scene.id || !scene.levels?.get(start.level)?.isView)
    throw new RuleError('The GM must view this token’s scene and level to check the forced movement.');
  const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.move;
  if (typeof backend?.testCollision !== 'function')
    throw new RuleError('Native movement collision checks are unavailable.');
  const length = Math.hypot(start.x - origin.x, start.y - origin.y);
  if (length < 0.001)
    throw new RuleError(
      'Overlapping token centres have no outward direction; separate the tokens before resolving the push.'
    );
  const unit = { x: (start.x - origin.x) / length, y: (start.y - origin.y) / length },
    size = token.getSize(token._source ?? token);
  const vector = { x: unit.x * metres * scale.pixelsPerMetre, y: unit.y * metres * scale.pixelsPerMetre };
  const corners = [
    { x: 0, y: 0 },
    ...[-1, 1].flatMap((x) =>
      [-1, 1].map((y) => ({
        x: x * Math.max(0, size.width / 2 - 0.1),
        y: y * Math.max(0, size.height / 2 - 0.1),
      }))
    ),
  ];
  const overlaps = (other, fraction) => {
    const otherSize = other.getSize(other._source ?? other),
      x = token.x + vector.x * fraction,
      y = token.y + vector.y * fraction;
    return (
      x < other.x + otherSize.width - 0.01 &&
      x + size.width > other.x + 0.01 &&
      y < other.y + otherSize.height - 0.01 &&
      y + size.height > other.y + 0.01
    );
  };
  const solidTokens = values(scene.tokens).filter(
    (other) =>
      other.id !== token.id &&
      other.id !== sourceToken.id &&
      other.level === token.level &&
      Math.abs(other.elevation - token.elevation) < 0.001 &&
      !overlaps(other, 0)
  );
  const collisionAt = (fraction) => {
    const p = {
      x: start.x + vector.x * fraction,
      y: start.y + vector.y * fraction,
      elevation: start.elevation,
    };
    const rect = scene.dimensions?.sceneRect;
    if (
      rect &&
      (p.x - size.width / 2 < rect.x ||
        p.y - size.height / 2 < rect.y ||
        p.x + size.width / 2 > rect.x + rect.width ||
        p.y + size.height / 2 > rect.y + rect.height)
    )
      return { kind: 'sceneBoundary' };
    const other = solidTokens.find((row) => overlaps(row, fraction));
    if (other) return { kind: 'token', tokenUuid: other.uuid, actorUuid: other.actor?.uuid ?? '' };
    if (
      corners.some((offset) => {
        const from = { x: start.x + offset.x, y: start.y + offset.y, elevation: start.elevation },
          to = { x: p.x + offset.x, y: p.y + offset.y, elevation: start.elevation },
          options = { type: 'move', mode: 'any', level: scene.levels.get(start.level) };
        return backend.testCollision(from, to, options) || scene.testSurfaceCollision?.(from, to, options);
      })
    )
      return { kind: 'wall' };
    return null;
  };
  // Sweep at <=0.1m and refine first contact; checking only the endpoint would tunnel through tokens.
  const steps = Math.max(1, Math.ceil(metres / 0.1));
  let fraction = 1,
    collision = null;
  for (let index = 1; index <= steps; index++) {
    const hit = collisionAt(index / steps);
    if (!hit) continue;
    let low = (index - 1) / steps,
      high = index / steps;
    for (let attempt = 0; attempt < 20; attempt++) {
      const mid = (low + high) / 2;
      if (collisionAt(mid)) high = mid;
      else low = mid;
    }
    fraction = low;
    collision = hit;
    break;
  }
  // V14 Token x/y are integer fields. Round displacement toward the origin,
  // then recheck the resulting segment so coercion cannot place a token through a wall.
  const original = { ...vector };
  vector.x = Math.trunc(original.x * fraction);
  vector.y = Math.trunc(original.y * fraction);
  while ((vector.x || vector.y) && collisionAt(1)) {
    if (vector.x) vector.x -= Math.sign(vector.x);
    if (vector.y) vector.y -= Math.sign(vector.y);
  }
  return {
    changes: { x: token.x + vector.x, y: token.y + vector.y },
    distance: Math.hypot(vector.x, vector.y) / scale.pixelsPerMetre,
    collision,
    self: false,
  };
}

export async function executeWindMove(
  operation,
  { data, caster, target, sourceToken, affectedToken, operationIndex, message }
) {
  requireGM();
  if (!windMoveSupported(operation)) throw new RuleError('Unsupported forced magical movement.');
  const receiptId = `${data.executionId ?? data.castId}:${operationIndex}:${affectedToken?.uuid}`;
  const receipts = affectedToken?.flags?.[SYSTEM_ID]?.windMovement ?? {};
  if (receipts[receiptId])
    return { status: 'applied', receipt: receipts[receiptId], rollback: async () => {} };
  const plan = windPushPlan(sourceToken, affectedToken, operation.distance),
    before = { x: affectedToken.x, y: affectedToken.y };
  let card;
  const receipt = {
    id: receiptId,
    ...plan,
    requestedDistance: operation.distance,
    tokenUuid: affectedToken.uuid,
    casterUuid: caster.uuid,
  };
  try {
    if (plan.collision)
      card = await chat(
        caster,
        'Zephyr: collision',
        `<p>${e(target.name)} travelled ${Math.round(plan.distance * 100) / 100}m before ${e(plan.collision.kind)} contact. Core p.171 supplies speed dice but no base ramming damage for a magically pushed person. Record the GM’s base damage and impacted-target weight before rolling.</p><button type="button" data-wind-collision>Resolve collision (GM)</button>`,
        {
          flags: {
            kind: 'wind-collision',
            castId: data.castId,
            parentMagicMessage: message.uuid,
            casterUuid: caster.uuid,
            targetUuid: target.uuid,
            sourceTokenUuid: sourceToken.uuid,
            tokenUuid: affectedToken.uuid,
            ...receipt,
            resolved: false,
          },
        }
      );
    receipt.collisionMessageUuid = card?.uuid ?? '';
    await affectedToken.update(
      { ...plan.changes, [`flags.${SYSTEM_ID}.windMovement`]: { ...copy(receipts), [receiptId]: receipt } },
      { witcherForcedMovement: true }
    );
    if (
      !affectedToken.flags?.[SYSTEM_ID]?.windMovement?.[receiptId] ||
      Object.entries(plan.changes).some(([key, value]) => affectedToken[key] !== value)
    )
      throw new RuleError(
        'The token movement was cancelled or changed. Resolve the movement restriction before retrying.'
      );
    return {
      status: plan.collision ? 'pendingGM' : 'applied',
      receipt,
      rollback: async () => {
        await affectedToken.update(
          { ...before, [`flags.${SYSTEM_ID}.windMovement`]: copy(receipts) },
          { witcherForcedMovement: true }
        );
        if (card) await card.delete();
      },
    };
  } catch (error) {
    if (card) await card.delete();
    await affectedToken.update(
      { ...before, [`flags.${SYSTEM_ID}.windMovement`]: copy(receipts) },
      { witcherForcedMovement: true }
    );
    throw error;
  }
}

async function resolveWindCollision({ messageUuid, values: choice }, { user }) {
  requireGM(user);
  const message = await foundry.utils.fromUuid(messageUuid),
    data = message?.flags?.[SYSTEM_ID];
  if (!message?.author?.isGM || data?.kind !== 'wind-collision')
    throw new RuleError('Choose the original GM collision card.');
  if (data.resolved) throw new RuleError('This collision was already resolved.');
  const token = await foundry.utils.fromUuid(data.tokenUuid),
    caster = await foundry.utils.fromUuid(data.casterUuid);
  if (!token?.actor || !caster || !token.flags?.[SYSTEM_ID]?.windMovement?.[data.id])
    throw new RuleError('The saved forced movement is missing.');
  const formula = String(choice?.baseFormula ?? '').trim(),
    ruling = String(choice?.ruling ?? '').trim();
  if (!/^(?:0|[1-9]\d?|(?:[1-9]|1\d|20)d6(?:\+[1-9]\d?)?)$/.test(formula) || !ruling)
    throw new RuleError('Record base damage (0, a number, or up to 20d6) and the GM’s collision ruling.');
  if (!['veryLight', 'light', 'medium', 'heavy'].includes(choice.weight))
    throw new RuleError('The GM must choose the impacted target’s weight class.');
  if (!['torso', 'random', ''].includes(choice.location ?? 'torso'))
    throw new RuleError('Choose torso or a random collision hit location.');
  const speedDice = mountedDamage({ distance: data.distance + 0.000001, weight: choice.weight }).dice;
  const struck = data.collision.tokenUuid ? await foundry.utils.fromUuid(data.collision.tokenUuid) : null;
  if (choice.damageStruck && !struck?.actor) throw new RuleError('There is no recorded struck actor.');
  const { magicDamageCard } = await import('./magic-runtime.js');
  const cards = [];
  try {
    const base = await dice(formula),
      speed = speedDice ? await dice(`${speedDice}d6`) : { total: 0 };
    const result = mountedDamage({
      distance: data.distance + 0.000001,
      weight: choice.weight,
      speedRoll: speed.total,
      baseRoll: base.total,
    });
    const targets = [token, ...(choice.damageStruck ? [struck] : [])];
    for (const recipient of targets) {
      const collisionData = {
        name: 'Zephyr: ramming collision',
        magicKey: 'zephyr',
        castId: data.castId,
        executionId: `collision:${message.id}`,
        itemId: 'wind-collision',
        tokenUuid: data.sourceTokenUuid,
        magic: { ...magicInfo('zephyr'), effect: { physicalCritical: false } },
        check: null,
        resolved: {
          damageFormula: String(result.total),
          damageType: 'bludgeoning',
          location: ['random', ''].includes(choice.location) ? '' : 'torso',
        },
        operationProperties: { magic: false, environmental: true, damageSource: 'ramming' },
      };
      cards.push(
        await magicDamageCard(caster, recipient.actor, collisionData, { tokenUuid: recipient.uuid })
      );
    }
    cards.push(
      await chat(
        caster,
        'Ramming damage',
        `<p>Base ${base.total} + ${speedDice}d6 (${speed.total}) × ${result.multiplier} = ${result.total}. GM ruling: ${e(ruling)}. Damage cards apply armor and location normally.</p>`,
        { rolls: [base, ...(speedDice ? [speed] : [])] }
      )
    );
    await message.update({
      [`flags.${SYSTEM_ID}.resolved`]: true,
      [`flags.${SYSTEM_ID}.ruling`]: { ...choice, result },
      [`flags.${SYSTEM_ID}.damageCards`]: cards.map((card) => card.uuid),
      content: `<article class="witcher-chat"><h3>Zephyr collision resolved</h3><p>Ramming damage ${result.total}; apply the separate damage card(s). GM ruling: ${e(ruling)}</p></article>`,
    });
    return cards[0];
  } catch (error) {
    for (const card of cards) await card.delete();
    throw error;
  }
}

let hooksInstalled = false;
export function registerWindFog() {
  registerSpellExecutionAdapters({
    supportsMove: windMoveSupported,
    executeMove: executeWindMove,
    supportsZone: modifierZoneSupported,
    createSpecialZone: createModifierZone,
  });
  registerCommand('magicWindCollision', resolveWindCollision);
  if (hooksInstalled) return;
  hooksInstalled = true;
  const schedule = (...args) => {
    if (!isPrimaryActiveGm() || args.some((arg) => arg?.witcherModifierZone)) return;
    serial('witcher-authority', () => refreshModifierZones()).catch(errorNotice);
  };
  for (const hook of [
    'createToken',
    'updateToken',
    'deleteToken',
    'createRegion',
    'updateRegion',
    'deleteRegion',
    'updateWorldTime',
    'updateActor',
    'canvasReady',
  ])
    Hooks.on(hook, schedule);
  Hooks.on('renderChatMessageHTML', (message, html) => {
    const button = html.querySelector('[data-wind-collision]');
    if (!button) return;
    button.hidden = !game.user.isGM;
    button.addEventListener('click', async () => {
      try {
        const data = message.flags[SYSTEM_ID];
        const answer = await prompt(
          'Ramming collision: GM ruling',
          '<p>The book gives vehicle/mount base damage, but does not specify a human base for magical pushes. Record your ruling. Speed damage uses actual travel before collision. Torso is a selectable GM location convention, not a printed ramming-location rule.</p>' +
            input('baseFormula', 'Base damage formula (explicit GM ruling)', { type: 'text', value: '' }) +
            input('weight', 'Impacted target weight', {
              options: {
                '': 'Choose the impacted target’s weight',
                veryLight: 'Very light ×½',
                light: 'Light ×1',
                medium: 'Medium ×2',
                heavy: 'Heavy ×3',
              },
            }) +
            input('location', 'Damage location', {
              options: { torso: 'Torso (GM convention)', random: 'Random hit location' },
            }) +
            (data.collision.tokenUuid
              ? input('damageStruck', 'Also damage the struck creature (GM ruling)', { type: 'checkbox' })
              : '') +
            input('ruling', 'Recorded collision ruling', { type: 'text' }),
          { button: 'Roll collision damage' }
        );
        if (answer)
          await runCommand('magicWindCollision', {
            messageUuid: message.uuid,
            values: { ...answer, location: answer.location === 'random' ? '' : answer.location },
          });
      } catch (error) {
        errorNotice(error);
      }
    });
  });
}
