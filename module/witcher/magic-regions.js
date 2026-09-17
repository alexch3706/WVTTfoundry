/** Native Foundry V14 placement and geometry. This module never spends a caster's resources. */
export const MAGIC_REGION_FLAG = 'witcher-rilerena';
export const MAGIC_REGION_BEHAVIOR = 'witcher-rilerena.magicArea';

const clone = (value) => structuredClone(value);
const source = (document) => document?._source ?? document;
const tokenDocument = (token) => token?.document ?? token;
const list = (collection) => collection?.contents ?? Array.from(collection ?? []);

function finite(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  return value;
}

/** Read the actual scene scale. The usual 100 px / 2 m grid produces 50 px per metre. */
export function magicSceneScale(scene, { metresPerUnit } = {}) {
  const grid = scene?.grid;
  const size = finite(Number(grid?.size), 'Scene grid size', { min: Number.EPSILON });
  const distance = finite(Number(grid?.distance), 'Scene grid distance', { min: Number.EPSILON });
  const units = String(grid?.units ?? '')
    .trim()
    .toLowerCase();
  if (metresPerUnit === undefined) {
    if (!['m', 'meter', 'meters', 'metre', 'metres', 'м', 'метр', 'метры', 'метров'].includes(units))
      throw new Error(
        'Magic areas require a scene measured in metres, or an explicit metresPerUnit conversion.'
      );
    metresPerUnit = 1;
  }
  finite(metresPerUnit, 'Metres per scene unit', { min: Number.EPSILON });
  return { pixelsPerMetre: size / (distance * metresPerUnit), metresPerUnit };
}

export function magicTokenOrigin(token) {
  token = tokenDocument(token);
  if (!token?.parent || typeof token.getMovementOrigin !== 'function')
    throw new Error('A placed V14 caster token is required for an area spell.');
  const state = source(token);
  const center = token.getMovementOrigin(state);
  return {
    x: finite(center.x, 'Caster x'),
    y: finite(center.y, 'Caster y'),
    elevation: finite(center.elevation, 'Caster elevation'),
    level: state.level,
  };
}

/** Dimensions must come from the authoritative catalog; an unspecified cone angle is never invented. */
export function normalizeMagicArea(spec) {
  if (!spec || !['circle', 'cone', 'line', 'ray', 'rectangle'].includes(spec.shape))
    throw new Error('Magic area shape must be circle, cone, line, or rectangle.');
  const shape = spec.shape === 'ray' ? 'line' : spec.shape;
  const area = {
    shape,
    origin: spec.origin ?? 'caster',
    volume: spec.volume ?? 'level',
    wallRestriction: spec.wallRestriction === undefined ? 'move' : spec.wallRestriction,
    includeCaster: spec.includeCaster !== false,
    angleSource: spec.angleSource ?? 'rule',
  };
  if (!['caster', 'ranged'].includes(area.origin)) throw new Error('Unknown magic area origin.');
  if (!['ground', 'sphere', 'level'].includes(area.volume)) throw new Error('Unknown magic area volume.');
  if (area.volume === 'sphere' && shape !== 'circle') throw new Error('A spherical area requires a circle.');
  if (![false, 'move', 'sight'].includes(area.wallRestriction)) throw new Error('Unknown wall restriction.');
  if (!['rule', 'table'].includes(area.angleSource)) throw new Error('Unknown cone angle source.');
  if (shape === 'circle') area.radius = finite(spec.radius, 'Area radius', { min: Number.EPSILON });
  else if (shape === 'rectangle') {
    area.width = finite(spec.width, 'Area width', { min: Number.EPSILON });
    area.height = finite(spec.height, 'Area height', { min: Number.EPSILON });
  } else {
    area.distance = finite(spec.distance, 'Area length', { min: Number.EPSILON });
    if (shape === 'cone') {
      if (spec.angle === null || spec.angle === undefined)
        throw new Error(
          'The book does not specify this cone angle. Set an explicit, visible table convention first.'
        );
      area.angle = finite(spec.angle, 'Cone angle', { min: Number.EPSILON, max: 360 });
    } else area.width = finite(spec.width, 'Line width', { min: Number.EPSILON });
  }
  if (area.origin === 'ranged') area.range = finite(spec.range, 'Placement range', { min: 0 });
  if (spec.verticalHeight > 0)
    area.verticalHeight = finite(spec.verticalHeight, 'Area vertical height', { min: Number.EPSILON });
  if (spec.metresPerUnit !== undefined)
    area.metresPerUnit = finite(spec.metresPerUnit, 'Metres per scene unit', { min: Number.EPSILON });
  return area;
}

function placementData(placement, origin, area) {
  const x = finite(placement?.x ?? origin.x, 'Area x');
  const y = finite(placement?.y ?? origin.y, 'Area y');
  const rotation = finite(placement?.rotation ?? 0, 'Area rotation');
  if (area.origin === 'caster' && Math.hypot(x - origin.x, y - origin.y) > 0.01)
    throw new Error('The caster moved, or the area origin is no longer at the caster. Place the area again.');
  return { x, y, rotation: ((rotation % 360) + 360) % 360 };
}

function requireViewedLevel(scene, origin, area, canvasObject = globalThis.canvas) {
  if (!area.wallRestriction) return;
  if (!canvasObject?.ready || canvasObject.scene?.id !== scene.id || !scene.levels?.get(origin.level)?.isView)
    throw new Error(
      'The active GM must view the caster’s scene and level to validate walls for this magic area.'
    );
}

/** Pure document source builder; it does not construct, update, or persist a Foundry document. */
export function magicRegionData({
  scene,
  casterToken,
  spec,
  placement,
  name = 'Magic area',
  color = '#5599ff',
}) {
  casterToken = tokenDocument(casterToken);
  if (casterToken?.parent !== scene) throw new Error('The caster token belongs to another scene.');
  const area = normalizeMagicArea(spec);
  const scale = magicSceneScale(scene, area);
  const origin = magicTokenOrigin(casterToken);
  const point = placementData(placement, origin, area);
  if (
    area.origin === 'ranged' &&
    Math.hypot(point.x - origin.x, point.y - origin.y) / scale.pixelsPerMetre > area.range + 1e-8
  )
    throw new Error(`The area origin is outside the ${area.range} m casting range.`);
  const shape = { type: area.shape, x: point.x, y: point.y, hole: false, gridBased: false };
  if (area.shape === 'circle') shape.radius = area.radius * scale.pixelsPerMetre;
  else if (area.shape === 'rectangle')
    Object.assign(shape, {
      width: area.width * scale.pixelsPerMetre,
      height: area.height * scale.pixelsPerMetre,
      anchorX: 0.5,
      anchorY: 0.5,
      rotation: point.rotation,
    });
  else if (area.shape === 'cone')
    Object.assign(shape, {
      radius: area.distance * scale.pixelsPerMetre,
      angle: area.angle,
      rotation: point.rotation,
      curvature: 'round',
    });
  else
    Object.assign(shape, {
      length: area.distance * scale.pixelsPerMetre,
      width: area.width * scale.pixelsPerMetre,
      rotation: point.rotation,
    });
  let elevation = { bottom: null, top: null, topInclusive: true };
  if (area.verticalHeight)
    elevation = {
      bottom: source(casterToken).elevation,
      top: source(casterToken).elevation + area.verticalHeight / scale.metresPerUnit,
      topInclusive: true,
    };
  if (area.volume === 'ground')
    elevation = {
      bottom: source(casterToken).elevation,
      top: source(casterToken).elevation,
      topInclusive: true,
    };
  if (area.volume === 'sphere') {
    const radius = area.radius / scale.metresPerUnit;
    elevation = { bottom: origin.elevation - radius, top: origin.elevation + radius, topInclusive: true };
  }
  return {
    area,
    origin,
    placement: point,
    data: {
      name,
      color,
      shapes: [shape],
      elevation,
      levels: [origin.level],
      restriction: { enabled: !!area.wallRestriction, type: area.wallRestriction || 'move' },
      highlightMode: 'coverage',
      displayMeasurements: true,
      visibility: globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2,
      ownership: { default: globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2 },
      locked: true,
      // Fixed at cast time. Attaching Yrden to its caster would silently change its rules.
      attachment: { token: null },
    },
  };
}

function areaWarnings(area) {
  const warnings = [];
  if (area.shape === 'cone' && area.angleSource === 'table')
    warnings.push(`Cone angle ${area.angle}° is a table convention; the spell does not print an angle.`);
  if (area.volume === 'level')
    warnings.push(
      'The printed area does not define height. The preview covers this scene level; the GM can review elevated targets.'
    );
  if (area.volume === 'sphere')
    warnings.push(
      'The map shows the sphere’s widest footprint; target inclusion also checks elevation and token height.'
    );
  warnings.push(
    'Foundry token containment determines boundary coverage. The GM can explicitly override ambiguous targets.'
  );
  return warnings;
}

function createPreviewDocument(data, scene, RegionClass = globalThis.CONFIG?.Region?.documentClass) {
  if (!RegionClass) throw new Error('Native Foundry V14 Region documents are unavailable.');
  const region = new RegionClass(data, { parent: scene });
  if (data.restriction.enabled) region.updateShapeConstraints({ save: false });
  return region;
}

function sphereContains(token, region, area, origin, placement) {
  const state = source(token);
  const scale = magicSceneScale(token.parent, area);
  const bottom = state.elevation * scale.metresPerUnit;
  const top = bottom + (state.depth ?? 0) * token.parent.grid.distance * scale.metresPerUnit;
  const center = origin.elevation * scale.metresPerUnit;
  const vertical = Math.max(bottom - center, center - top, 0);
  if (vertical > area.radius) return false;
  const horizontalSquared = area.radius ** 2 - vertical ** 2;
  return token.getContainmentTestPoints(state).some((point) => {
    const distanceSquared =
      ((point.x - placement.x) ** 2 + (point.y - placement.y) ** 2) / scale.pixelsPerMetre ** 2;
    return distanceSquared <= horizontalSquared + 1e-8 && region.polygonTree.testPoint(point, 0.75);
  });
}

/** Native containment covers token size/shape, walls, elevation/depth, and V14 levels. */
export function magicRegionTargets({
  region,
  casterToken,
  spec,
  origin,
  placement,
  tokens = region.parent.tokens,
  requester = globalThis.game?.user,
  preview = false,
}) {
  const area = normalizeMagicArea(spec);
  casterToken = tokenDocument(casterToken);
  const candidates = [];
  for (const rawToken of list(tokens)) {
    const token = tokenDocument(rawToken);
    if (!token?.actor || (preview && token.hidden && !requester?.isGM)) continue;
    if (typeof token.testInsideRegion !== 'function')
      throw new Error('V14 TokenDocument.testInsideRegion is required.');
    let included = token.testInsideRegion(region);
    let reason = included ? 'inside' : 'outside-or-obstructed';
    if (!area.includeCaster && token.id === casterToken?.id) {
      included = false;
      reason = 'caster-excluded';
    } else if (
      included &&
      area.volume === 'sphere' &&
      !sphereContains(token, region, area, origin, placement)
    ) {
      included = false;
      reason = 'outside-sphere';
    }
    candidates.push({
      tokenId: token.id,
      tokenUuid: token.uuid,
      actorUuid: token.actor.uuid,
      name: token.name,
      included,
      reason,
    });
  }
  return candidates;
}

/**
 * Place a local-only native V14 preview. Escape/right-click cancellation returns null.
 * No Scene create/update call, target mutation, or STA expenditure occurs here.
 */
export async function previewMagicRegion({
  casterToken,
  spec,
  name,
  color,
  requester = globalThis.game?.user,
  canvasObject = globalThis.canvas,
}) {
  casterToken = tokenDocument(casterToken);
  const scene = casterToken?.parent;
  if (
    !canvasObject?.ready ||
    canvasObject.scene !== scene ||
    typeof canvasObject.regions?.placeRegion !== 'function'
  )
    throw new Error('View the caster’s scene on a ready Foundry V14 canvas before placing magic.');
  const built = magicRegionData({ scene, casterToken, spec, name, color });
  requireViewedLevel(scene, built.origin, built.area, canvasObject);
  const warn = (message) => globalThis.ui?.notifications?.warn(message);
  const document = await canvasObject.regions.placeRegion(built.data, {
    create: false,
    allowRotation: built.area.shape !== 'circle',
    attachToToken: false,
    onMove: ({ shape, position }) => {
      if (built.area.origin !== 'caster') return;
      const update = { x: built.origin.x, y: built.origin.y };
      if (built.area.shape !== 'circle')
        update.rotation =
          ((Math.atan2(position.y - built.origin.y, position.x - built.origin.x) * 180) / Math.PI + 360) %
          360;
      shape.updateSource(update);
      return false;
    },
    preConfirm: ({ document: current }) => {
      try {
        magicRegionData({ scene, casterToken, spec, placement: current.toObject().shapes[0], name, color });
        return true;
      } catch (error) {
        warn(error.message);
        return false;
      }
    },
  });
  if (!document) return null;
  const point = document.toObject().shapes[0];
  const validated = validateMagicRegion({
    scene,
    casterToken,
    spec,
    placement: point,
    name,
    color,
    requester,
    canvasObject,
    preview: true,
  });
  return {
    sceneId: scene.id,
    casterTokenId: casterToken.id,
    origin: validated.origin,
    placement: validated.placement,
    targetIds: validated.targetIds,
    candidates: validated.candidates,
    warnings: validated.warnings,
  };
}

/** Authoritative revalidation. Supply fresh catalog dimensions and the actual requesting user. */
export function validateMagicRegion({
  scene,
  casterToken,
  spec,
  placement,
  expectedOrigin,
  override,
  name,
  color,
  requester = globalThis.game?.user,
  canvasObject = globalThis.canvas,
  RegionClass,
  preview = false,
}) {
  const built = magicRegionData({ scene, casterToken, spec, placement, name, color });
  if (
    expectedOrigin &&
    ['x', 'y', 'elevation', 'level'].some((key) => expectedOrigin[key] !== built.origin[key])
  )
    throw new Error('The caster moved after the preview. Place the magic area again.');
  requireViewedLevel(scene, built.origin, built.area, canvasObject);
  if (built.area.origin === 'ranged' && built.area.wallRestriction) {
    const type = built.area.wallRestriction;
    const backend = globalThis.CONFIG?.Canvas?.polygonBackends?.[type];
    if (typeof backend?.testCollision !== 'function')
      throw new Error('Native V14 wall collision checks are unavailable.');
    if (
      backend.testCollision(
        built.origin,
        { ...built.placement, elevation: built.origin.elevation },
        {
          type,
          mode: 'any',
          level: scene.levels.get(built.origin.level),
        }
      )
    )
      throw new Error('A wall blocks the path from the caster to the selected area origin.');
  }
  const region = createPreviewDocument(built.data, scene, RegionClass);
  const candidates = magicRegionTargets({
    region,
    casterToken,
    spec: built.area,
    origin: built.origin,
    placement: built.placement,
    requester,
    preview,
  });
  let appliedOverride = null;
  if (override && ((override.include?.length ?? 0) || (override.exclude?.length ?? 0))) {
    if (!requester?.isGM) throw new Error('Only the GM may override area target inclusion.');
    if (typeof override.reason !== 'string' || !override.reason.trim())
      throw new Error('Explain the GM area-target override.');
    const include = new Set(override.include ?? []);
    const exclude = new Set(override.exclude ?? []);
    for (const id of [...include, ...exclude]) {
      if (!candidates.some((target) => target.tokenId === id))
        throw new Error('An overridden target is not a token in this scene.');
      if (include.has(id) && exclude.has(id))
        throw new Error('An overridden target cannot be both included and excluded.');
    }
    for (const target of candidates) {
      if (include.has(target.tokenId) || exclude.has(target.tokenId)) {
        target.included = include.has(target.tokenId);
        target.reason = 'gm-override';
      }
    }
    appliedOverride = {
      include: [...include],
      exclude: [...exclude],
      reason: override.reason.trim(),
      userId: requester.id,
    };
  }
  return {
    ...built,
    region,
    targetIds: candidates.filter((target) => target.included).map((target) => target.tokenId),
    candidates,
    warnings: areaWarnings(built.area),
    override: appliedOverride,
  };
}

function requireGM() {
  if (!globalThis.game?.user?.isGM)
    throw new Error('Persistent magic regions must be changed by the authoritative GM.');
}

export function magicRegionState(region) {
  return region?.flags?.[MAGIC_REGION_FLAG]?.magicArea ?? null;
}

/** Call inside the cast authority queue/compensated transaction after a successful cast. */
export async function createMagicRegion({
  scene,
  casterToken,
  spec,
  placement,
  expectedOrigin,
  requester,
  override,
  name,
  color,
  links,
  rounds,
  state = {},
  validatedCast,
}) {
  requireGM();
  for (const key of ['castId', 'casterUuid', 'spellUuid'])
    if (typeof links?.[key] !== 'string' || !links[key])
      throw new Error(`A persistent magic area requires ${key}.`);
  if (!Number.isInteger(rounds) || rounds < 1)
    throw new Error('A persistent magic area requires positive whole rounds.');
  // A GM-authored casting card may carry geometry already validated when STA
  // was spent. Later token movement must not relocate that saved casting.
  const validated =
    validatedCast ??
    validateMagicRegion({
      scene,
      casterToken,
      spec,
      placement,
      expectedOrigin,
      requester,
      override,
      name,
      color,
    });
  const metadata = {
    ...clone(state),
    version: 1,
    ...links,
    casterTokenId: tokenDocument(casterToken).id,
    spec: validated.area,
    origin: validated.origin,
    placement: validated.placement,
    override: validated.override,
    roundsRemaining: rounds,
    occupantIds: [],
    turnEvents: {},
    lastRound: null,
  };
  const data = {
    ...validated.data,
    flags: { [MAGIC_REGION_FLAG]: { magicArea: metadata } },
    behaviors: [{ name: 'Witcher magic area', type: MAGIC_REGION_BEHAVIOR, system: {} }],
  };
  const [region] = await scene.createEmbeddedDocuments('Region', [data]);
  if (!region) throw new Error('The magic Region was not created.');
  return region;
}

/** State-only update: callers cannot use this helper to change trusted geometry or source links. */
export async function updateMagicRegion(region, changes) {
  requireGM();
  if (!magicRegionState(region)) throw new Error('This is not a Witcher magic Region.');
  const allowed = new Set([
    'roundsRemaining',
    'occupantIds',
    'turnEvents',
    'lastRound',
    'active',
    'prepared',
    'lastAttack',
  ]);
  const update = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!allowed.has(key)) throw new Error(`Unknown magic Region state field: ${key}.`);
    if (key === 'roundsRemaining' && (!Number.isInteger(value) || value < 0))
      throw new Error('Remaining rounds must be a non-negative integer.');
    update[`flags.${MAGIC_REGION_FLAG}.magicArea.${key}`] = clone(value);
  }
  return region.update(update);
}

export async function deleteMagicRegion(region) {
  requireGM();
  if (!magicRegionState(region)) throw new Error('This is not a Witcher magic Region.');
  return region.delete();
}

/** A pure idempotency plan; persist the returned changes only after the corresponding effect succeeds. */
export function magicRegionEventUpdate(region, event) {
  const state = magicRegionState(region);
  if (!state) throw new Error('This is not a Witcher magic Region.');
  const token = tokenDocument(event.data?.token);
  const tokenId = token?.id;
  if (!tokenId) return { duplicate: true, changes: {} };
  const occupants = new Set(state.occupantIds ?? []);
  if (event.name === 'tokenEnter' || event.name === 'tokenExit') {
    const enter = event.name === 'tokenEnter';
    if (occupants.has(tokenId) === enter) return { duplicate: true, changes: {} };
    if (enter) occupants.add(tokenId);
    else occupants.delete(tokenId);
    return { duplicate: false, changes: { occupantIds: [...occupants] } };
  }
  if (!['tokenTurnStart', 'tokenTurnEnd', 'tokenRoundStart', 'tokenRoundEnd'].includes(event.name))
    return { duplicate: true, changes: {} };
  const combatId = event.data?.combat?.id;
  const { round } = event.data ?? {};
  const turn = event.name.startsWith('tokenRound') ? 0 : event.data?.turn;
  if (!combatId || !Number.isInteger(round) || !Number.isInteger(turn))
    throw new Error('A magic area turn event requires a combat, round, and turn.');
  const key = `${event.name}:${tokenId}`;
  const marker = { combatId, round, turn };
  const previous = state.turnEvents?.[key];
  if (
    previous?.combatId === combatId &&
    (previous.round > round || (previous.round === round && previous.turn >= turn))
  )
    return { duplicate: true, changes: {} };
  return { duplicate: false, changes: { turnEvents: { ...state.turnEvents, [key]: marker } } };
}

/** One duration tick per combat round, irrespective of how many tokens are inside. Rewinds never tick. */
export function magicRegionRoundUpdate(region, { combatId, round }) {
  const state = magicRegionState(region);
  if (!state || !combatId || !Number.isInteger(round) || round < 0)
    throw new Error('Invalid magic area round context.');
  if (state.lastRound?.combatId === combatId && state.lastRound.round >= round)
    return { duplicate: true, expired: state.roundsRemaining === 0, changes: {} };
  const elapsed = state.lastRound?.combatId === combatId ? Math.max(1, round - state.lastRound.round) : 1;
  const roundsRemaining = Math.max(0, state.roundsRemaining - elapsed);
  return {
    duplicate: false,
    expired: roundsRemaining === 0,
    changes: { roundsRemaining, lastRound: { combatId, round } },
  };
}

/** Register during init. The handler must enter the system's existing authoritative command queue. */
export function registerMagicRegionBehavior(handler, { isAuthority } = {}) {
  const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType;
  if (!Base || !globalThis.CONFIG?.RegionBehavior?.dataModels)
    throw new Error('Foundry V14 RegionBehavior models are unavailable.');
  if (typeof handler !== 'function' || typeof isAuthority !== 'function')
    throw new Error('A Region handler and authority predicate are required.');
  const dispatch = async function (event) {
    if (!isAuthority() || !magicRegionState(event.region)) return;
    await handler(event);
  };
  class WitcherMagicAreaBehavior extends Base {
    static defineSchema() {
      return {};
    }
    static events = Object.fromEntries(
      ['tokenEnter', 'tokenExit', 'tokenTurnStart', 'tokenTurnEnd', 'tokenRoundStart', 'tokenRoundEnd'].map(
        (name) => [name, dispatch]
      )
    );
  }
  globalThis.CONFIG.RegionBehavior.dataModels[MAGIC_REGION_BEHAVIOR] = WitcherMagicAreaBehavior;
  return WitcherMagicAreaBehavior;
}
