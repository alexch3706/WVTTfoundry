import { SYSTEM_ID } from './config.js';
import { actorSnapshot } from './documents.js';
import { commitActor } from './runtime.js';

const values = (collection) => Array.from(collection ?? []);
function tokenByUuid(uuid) {
  for (const scene of values(globalThis.game?.scenes))
    for (const token of values(scene.tokens)) if (token.uuid === uuid) return token;
  return null;
}
export function pressedTogether(a, b) {
  if (!a || !b || a.parent?.id !== b.parent?.id || a.elevation !== b.elevation) return false;
  const grid = a.parent.grid.size;
  const dx = Math.max(a.x - b.x - b.width * grid, b.x - a.x - a.width * grid, 0);
  const dy = Math.max(a.y - b.y - b.height * grid, b.y - a.y - a.height * grid, 0);
  return Math.hypot(dx, dy) < 0.01;
}
export function companionShield(actor) {
  const link = actor.system.effects.find((effect) => effect.magic?.key === 'active-shield-companion');
  if (!link) return null;
  const source = tokenByUuid(link.magic.tokenUuid),
    target = tokenByUuid(link.magic.companionTokenUuid);
  if (target?.actor?.uuid !== actor.uuid || !pressedTogether(source, target)) return null;
  const owner = source.actor;
  const shield = owner?.system.effects.find(
    (effect) =>
      effect.magic?.castId === link.magic.castId &&
      effect.magic?.key === 'active-shield' &&
      effect.shieldHP > 0 &&
      effect.magic.companionUuid === target.uuid
  );
  return shield ? { owner, shield, link } : null;
}
export function activeShieldFor(actor) {
  return (
    actor.system.effects.find((effect) => effect.magic?.key === 'active-shield' && effect.shieldHP > 0) ??
    companionShield(actor)?.shield
  );
}
export function magicDamageSnapshot(actor) {
  const state = actorSnapshot(actor),
    shared = companionShield(actor);
  if (shared)
    state.effects = [
      { ...structuredClone(shared.shield), ownerActorUuid: shared.owner.uuid },
      ...state.effects,
    ];
  return state;
}
export function shieldOwner(uuid) {
  for (const actor of values(globalThis.game?.actors)) if (actor.uuid === uuid) return actor;
  for (const scene of values(globalThis.game?.scenes))
    for (const token of values(scene.tokens)) if (token.actor?.uuid === uuid) return token.actor;
  return null;
}
/** Persist a shared pool and victim changes together, compensating either side on failure. */
export async function commitDamage(actor, planned, itemChanges = planned.items, after) {
  const entries = [...(planned.wards ?? new Map()).entries()];
  const apply = async (index) => {
    if (index === entries.length) return commitActor(actor, planned.actor, itemChanges, after);
    const [uuid, effects] = entries[index],
      owner = shieldOwner(uuid);
    if (!owner) throw new Error('The shared Active Shield owner no longer exists.');
    return commitActor(owner, { 'system.effects': effects }, [], () => apply(index + 1));
  };
  return apply(0);
}
