const LEGACY_SYSTEM_ID = "cyberpunk2020";
const DEFAULT_COLOR = "#ff0000";

/**
 * Convert a distance expressed in Scene units to canvas pixels.
 * Foundry V14 exposes the conversion directly on CanvasDimensions.
 */
export function sceneUnitsToPixels(value) {
  const units = Number(value);
  const distancePixels = Number(globalThis.canvas?.dimensions?.distancePixels);
  if(!Number.isFinite(units)) {
    throw new TypeError("Region distance must be a finite number.");
  }
  if(!Number.isFinite(distancePixels) || distancePixels <= 0) {
    throw new Error("Canvas distance conversion is unavailable.");
  }
  return units * distancePixels;
}

/** Convert canvas pixels to Scene units. */
export function pixelsToSceneUnits(value) {
  const pixels = Number(value);
  const distancePixels = Number(globalThis.canvas?.dimensions?.distancePixels);
  if(!Number.isFinite(pixels)) {
    throw new TypeError("Pixel distance must be a finite number.");
  }
  if(!Number.isFinite(distancePixels) || distancePixels <= 0) {
    throw new Error("Canvas distance conversion is unavailable.");
  }
  return pixels / distancePixels;
}

/** Return a RegionDocument whether supplied a RegionDocument or its placeable. */
export function getRegionDocument(value) {
  return value?.document || value?.object?.document || value || null;
}

/** Return the first shape belonging to a RegionDocument or Region placeable. */
export function getPrimaryRegionShape(region) {
  const shapes = getRegionDocument(region)?.shapes;
  if(!shapes) return null;
  if(typeof shapes.at === "function") return shapes.at(0) || null;
  return Array.from(shapes)[0] || null;
}

/**
 * Resolve a token center in canvas pixels. Token placeables and TokenDocuments
 * are both accepted. A document position fallback is used for unrendered tokens.
 */
export function getTokenCenter(tokenOrDocument) {
  const token = tokenOrDocument?.document ? tokenOrDocument : tokenOrDocument?.object;
  const document = tokenOrDocument?.document || tokenOrDocument || token?.document;
  if(typeof document?.getCenterPoint === "function") {
    try {
      const point = document.getCenterPoint();
      if(isFinitePoint(point)) return { x: Number(point.x), y: Number(point.y) };
    } catch(error) {
      console.warn("Failed to resolve the TokenDocument center:", error);
    }
  }
  const center = token?.center
    || tokenOrDocument?.center
    || document?.object?.center
    || tokenOrDocument?.bounds?.center
    || document?.bounds?.center;

  if(isFinitePoint(center)) {
    return { x: Number(center.x), y: Number(center.y) };
  }

  const x = Number(document?.x ?? tokenOrDocument?.x);
  const y = Number(document?.y ?? tokenOrDocument?.y);
  const gridSize = Number(
    document?.parent?.dimensions?.size
      ?? tokenOrDocument?.parent?.dimensions?.size
      ?? globalThis.canvas?.dimensions?.size
      ?? globalThis.canvas?.grid?.size
  );
  const width = Number(document?.width ?? tokenOrDocument?.width ?? 1);
  const height = Number(document?.height ?? tokenOrDocument?.height ?? 1);
  if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(gridSize) || gridSize <= 0) {
    return null;
  }

  return {
    x: x + ((Number.isFinite(width) ? width : 1) * gridSize / 2),
    y: y + ((Number.isFinite(height) ? height : 1) * gridSize / 2)
  };
}

/** Test the center and elevation of a token against a RegionDocument. */
export function regionContainsToken(region, tokenOrDocument) {
  const document = getRegionDocument(region);
  const center = getTokenCenter(tokenOrDocument);
  if(typeof document?.testPoint !== "function" || !center) return false;

  const tokenDocument = tokenOrDocument?.document || tokenOrDocument;
  const elevation = finiteNumber(
    tokenDocument?.elevation
      ?? tokenOrDocument?.elevation
      ?? tokenDocument?.object?.document?.elevation,
    0
  );

  try {
    return document.testPoint({ ...center, elevation }) === true;
  } catch(error) {
    console.warn("Failed to test token against combat Region:", error);
    return false;
  }
}

/**
 * Build V14 Region data for a weapon Area of Effect.
 * Supported legacy names are mapped onto public Region shape types.
 */
export function buildAoERegionData({
  type = "cone",
  distance = 10,
  width,
  height,
  angle = 45,
  origin,
  name,
  color,
  userId,
  flags = {}
} = {}) {
  const normalizedOrigin = requirePoint(origin, "Area-of-effect origin");
  const normalizedType = normalizeAoEType(type);
  const distanceUnits = positiveNumber(distance, 10);
  const shape = buildAoEShape({
    type: normalizedType,
    distance: distanceUnits,
    width,
    height,
    angle,
    origin: normalizedOrigin
  });

  const legacyType = String(type || "cone").toLowerCase();
  const combatRegion = compactObject({
    kind: "aoe",
    templateType: legacyType,
    distance: distanceUnits,
    width: width === undefined ? undefined : positiveNumber(width, distanceUnits),
    height: height === undefined ? undefined : positiveNumber(height, distanceUnits),
    angle: normalizedType === "cone" ? finiteNumber(angle, 45) : undefined
  });

  return buildRegionData({
    name: name || `${capitalize(legacyType)} Area of Effect`,
    color,
    userId,
    shape,
    flags: mergeSystemFlag(flags, "combatRegion", combatRegion)
  });
}

/** Build V14 Region data for a persistent suppressive-fire corridor. */
export function buildSuppressiveFireRegionData({
  attackerTokenId,
  attackerTokenUuid,
  attackerActorId,
  attackerActorUuid,
  weaponItemId,
  weaponItemUuid,
  damageFormula,
  bulletsFired,
  zoneWidth,
  maxDistance,
  origin,
  combatRound,
  combatTurn,
  combatId,
  name = "Suppressive Fire",
  color,
  userId,
  flags = {}
} = {}) {
  const normalizedOrigin = requirePoint(origin, "Suppressive-fire origin");
  const normalizedBullets = Math.max(0, Math.floor(finiteNumber(bulletsFired, 0)));
  const normalizedWidth = positiveNumber(zoneWidth, 2);
  const normalizedDistance = positiveNumber(maxDistance, 10);
  const round = Math.max(0, Math.floor(finiteNumber(combatRound, 0)));
  const turn = Math.max(0, Math.floor(finiteNumber(combatTurn, 0)));
  const saveDC = Math.floor(normalizedBullets / Math.max(2, normalizedWidth));

  const suppressiveFire = compactObject({
    shooterActorId: attackerActorId,
    shooterActorUuid: attackerActorUuid,
    shooterTokenId: attackerTokenId,
    shooterTokenUuid: attackerTokenUuid,
    weaponItemId,
    weaponItemUuid,
    damageFormula: damageFormula || "1d6",
    bulletsFired: normalizedBullets,
    remainingHitCap: normalizedBullets,
    saveDC,
    zoneWidth: normalizedWidth,
    maxDistance: normalizedDistance,
    createdCombatId: combatId || "",
    createdRound: round,
    createdTurn: turn,
    expiresAtRound: round + 1,
    expiresAtTurn: turn,
    resolvedTokenIds: []
  });

  return buildRegionData({
    name,
    color,
    userId,
    shape: {
      type: "line",
      x: normalizedOrigin.x,
      y: normalizedOrigin.y,
      length: sceneUnitsToPixels(normalizedDistance),
      width: sceneUnitsToPixels(normalizedWidth),
      rotation: 0,
      gridBased: false
    },
    flags: mergeSystemFlag(flags, "suppressiveFire", suppressiveFire)
  });
}

/**
 * Place a combat Region with the public Foundry V14 RegionLayer API.
 * Supplying anchorOrigin pins the shape to that point and makes pointer motion
 * rotate it around the anchor rather than translate it.
 */
export async function placeCombatRegion(regionData, {
  create = false,
  anchorOrigin,
  onMove,
  ...placementOptions
} = {}) {
  const activeCanvas = globalThis.canvas;
  if(!activeCanvas?.ready) {
    throw new Error("Canvas is not ready.");
  }
  if(typeof activeCanvas.regions?.placeRegion !== "function") {
    throw new Error("The Foundry V14 Region placement API is unavailable.");
  }

  const options = { ...placementOptions, create: create === true };
  if(anchorOrigin !== undefined) {
    const anchor = requirePoint(anchorOrigin, "Region anchor");
    options.allowRotation ??= false;
    options.onMove = (context) => {
      rotateAnchoredShape(context, anchor);
      onMove?.(context);
      return false;
    };
  } else if(typeof onMove === "function") {
    options.onMove = onMove;
  }

  return activeCanvas.regions.placeRegion(regionData, options);
}

function buildAoEShape({ type, distance, width, height, angle, origin }) {
  const distancePx = sceneUnitsToPixels(distance);
  switch(type) {
    case "cone":
      return {
        type: "cone",
        x: origin.x,
        y: origin.y,
        radius: distancePx,
        angle: finiteNumber(angle, 45),
        rotation: 0,
        curvature: "flat",
        gridBased: false
      };
    case "circle":
      return {
        type: "circle",
        x: origin.x,
        y: origin.y,
        radius: distancePx,
        gridBased: false
      };
    case "rectangle":
      return {
        type: "rectangle",
        x: origin.x,
        y: origin.y,
        width: sceneUnitsToPixels(positiveNumber(width, distance)),
        height: sceneUnitsToPixels(positiveNumber(height, distance)),
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        gridBased: false
      };
    case "line":
      return {
        type: "line",
        x: origin.x,
        y: origin.y,
        length: distancePx,
        width: sceneUnitsToPixels(positiveNumber(width, defaultLineWidth())),
        rotation: 0,
        gridBased: false
      };
    default:
      throw new TypeError(`Unsupported Area-of-Effect type: ${type}`);
  }
}

function buildRegionData({ name, color, userId, shape, flags }) {
  const ownerId = userId || globalThis.game?.user?.id;
  const ownershipLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const visibility = globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2;
  const levelId = globalThis.canvas?.level?.id;
  return {
    name,
    shapes: [shape],
    color: color || globalThis.game?.user?.color || DEFAULT_COLOR,
    restriction: { enabled: false },
    levels: levelId ? [levelId] : [],
    highlightMode: "coverage",
    displayMeasurements: true,
    visibility,
    ownership: ownerId ? { [ownerId]: ownershipLevel } : {},
    flags
  };
}

function rotateAnchoredShape({ shape, preview, position } = {}, anchor) {
  if(!shape || !isFinitePoint(position)) return;
  const rotation = normalizeDegrees(
    Math.atan2(Number(position.y) - anchor.y, Number(position.x) - anchor.x) * 180 / Math.PI
  );
  const update = { x: anchor.x, y: anchor.y, rotation };
  if(typeof shape.updateSource === "function") shape.updateSource(update);
  else Object.assign(shape, update);
  preview?.renderFlags?.set?.({ refreshGeometry: true });
}

function mergeSystemFlag(flags, key, value) {
  const systemId = globalThis.game?.system?.id || LEGACY_SYSTEM_ID;
  return {
    ...flags,
    [systemId]: {
      ...(flags?.[systemId] || {}),
      [key]: value
    }
  };
}

function normalizeAoEType(type) {
  const normalized = String(type || "cone").toLowerCase();
  if(normalized === "ray") return "line";
  if(normalized === "rect") return "rectangle";
  if(["cone", "circle", "rectangle", "line"].includes(normalized)) return normalized;
  throw new TypeError(`Unsupported Area-of-Effect type: ${type}`);
}

function defaultLineWidth() {
  return positiveNumber(
    globalThis.canvas?.dimensions?.distance ?? globalThis.canvas?.scene?.grid?.distance,
    1
  );
}

function requirePoint(value, label) {
  if(!isFinitePoint(value)) throw new TypeError(`${label} must contain finite x and y coordinates.`);
  return { x: Number(value.x), y: Number(value.y) };
}

function isFinitePoint(value) {
  return Number.isFinite(Number(value?.x)) && Number.isFinite(Number(value?.y));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function compactObject(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "Combat";
}
