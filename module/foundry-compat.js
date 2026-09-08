/**
 * Resolve Handlebars helpers across Foundry's legacy globals (V10-V12) and
 * the public namespaced API used by V13+.
 */
export function getFoundryHandlebarsFunction(name) {
  const handlebarsApi = globalThis.foundry?.applications?.handlebars;
  const modern = handlebarsApi?.[name];
  if(typeof modern === "function") return modern.bind(handlebarsApi);

  const legacy = globalThis[name];
  return typeof legacy === "function" ? legacy.bind(globalThis) : undefined;
}

export async function renderFoundryTemplate(path, data) {
  const renderer = getFoundryHandlebarsFunction("renderTemplate");
  if(!renderer) throw new Error("Foundry Handlebars renderTemplate API is unavailable.");
  return renderer(path, data);
}

export async function loadFoundryTemplates(paths) {
  const loader = getFoundryHandlebarsFunction("loadTemplates");
  if(!loader) throw new Error("Foundry Handlebars loadTemplates API is unavailable.");
  return loader(paths);
}

/** Resolve a UUID through the public V14 utility namespace. */
export async function resolveFoundryUuid(uuid) {
  const resolver = globalThis.foundry?.utils?.fromUuid || globalThis.fromUuid;
  if(typeof resolver !== "function") {
    throw new Error("Foundry fromUuid API is unavailable.");
  }
  return resolver(uuid);
}

/**
 * Resolve the public V14 Die term constructor without relying on the removed
 * blessed `Die` global.
 */
export function getFoundryDieClass() {
  const DieClass = globalThis.foundry?.dice?.terms?.Die;
  return typeof DieClass === "function" ? DieClass : undefined;
}

export function isFoundryDieTerm(term) {
  const DieClass = getFoundryDieClass();
  return Boolean(DieClass && term instanceof DieClass);
}

/**
 * Return an elevated token centre suitable for V14 grid and Region APIs.
 */
export function getTokenCenterPoint(tokenOrDocument) {
  const document = tokenOrDocument?.document || tokenOrDocument;
  if(typeof document?.getCenterPoint === "function") {
    try {
      const point = document.getCenterPoint();
      if(Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))) {
        return {
          x: Number(point.x),
          y: Number(point.y),
          elevation: Number(point.elevation ?? document.elevation ?? 0)
        };
      }
    } catch(error) {
      console.warn("Unable to read token centre through TokenDocument#getCenterPoint:", error);
    }
  }

  const center = tokenOrDocument?.center || document?.object?.center || tokenOrDocument?.bounds?.center;
  if(Number.isFinite(Number(center?.x)) && Number.isFinite(Number(center?.y))) {
    return {
      x: Number(center.x),
      y: Number(center.y),
      elevation: Number(center.elevation ?? document?.elevation ?? 0)
    };
  }

  const gridSize = Number(
    document?.parent?.dimensions?.size
    ?? tokenOrDocument?.parent?.dimensions?.size
    ?? globalThis.canvas?.dimensions?.size
    ?? globalThis.canvas?.grid?.size
    ?? 0
  );
  const x = Number(document?.x);
  const y = Number(document?.y);
  const width = Number(document?.width ?? 1);
  const height = Number(document?.height ?? 1);
  if(gridSize > 0 && [x, y, width, height].every(Number.isFinite)) {
    return {
      x: x + (width * gridSize / 2),
      y: y + (height * gridSize / 2),
      elevation: Number(document?.elevation ?? 0)
    };
  }
  return undefined;
}

/**
 * Measure token-to-token distance with the public V14 BaseGrid API.
 */
export function measureTokenDistance(source, target, grid = globalThis.canvas?.grid) {
  if(typeof grid?.measurePath !== "function") return undefined;
  const origin = getTokenCenterPoint(source);
  const destination = getTokenCenterPoint(target);
  if(!origin || !destination) return undefined;

  const measurement = grid.measurePath([origin, destination]);
  const distance = Number(measurement?.distance);
  return Number.isFinite(distance) ? distance : undefined;
}

export function foundryValuesEqual(left, right) {
  const equals = globalThis.foundry?.utils?.equals;
  if(typeof equals === "function") return equals(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Elect one active GM for effects which must be resolved exactly once even
 * though V14 lifecycle hooks are dispatched to every connected client.
 */
export function isPrimaryActiveGm(currentUser = globalThis.game?.user, users = globalThis.game?.users) {
  if(!currentUser?.isGM || currentUser.active === false) return false;

  // V14 exposes the same election used by core. It prefers a full Gamemaster
  // over an Assistant and is specifically intended for all-client workflows.
  if(typeof currentUser.isActiveGM === "boolean") return currentUser.isActiveGM;
  const activeGm = users?.activeGM;
  if(activeGm) return activeGm.id === currentUser.id;

  const activeGms = Array.from(users?.contents || users || [])
    .filter(user => user?.isGM && user?.active)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));

  // A minimal user collection is common during startup and in tests. In that
  // case a connected GM is the only available authority.
  return activeGms.length === 0 || activeGms[0]?.id === currentUser.id;
}
