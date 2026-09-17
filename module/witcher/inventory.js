import { RuleError, armorEncumbrance } from './rules.js';
import { registerCommand, authorizedActor, runCommand } from './authority.js';
import { actionPlan, commitActor, owner, chat, escapeHTML as e } from './runtime.js';
import { woundModifiers } from './wounds.js';

const system = (entry) => entry.system ?? entry;
const itemId = (entry) => entry.id ?? entry._id;
const snapshot = (entry) => ({
  id: itemId(entry),
  name: entry.name,
  type: entry.type,
  ...(entry.system?.toObject ? entry.system.toObject() : system(entry)),
});
const isHeld = (entry) => ['weapon', 'shield'].includes(entry.type) || system(entry).properties?.focus > 0;

/** Zero means use the printed grip. Natural attacks never occupy a hand. */
export function handsUsed(item) {
  const s = system(item);
  if (!isHeld(item) || s.properties?.natural) return 0;
  if (item.type === 'shield') return 1;
  return Number(s.handsUsed || s.hands || 1);
}

/** Repeated wounds on the same arm disable that arm only once. */
export function availableHands(actorState, items = actorState.items ?? []) {
  const state = system(actorState);
  const disabled = new Set();
  let unspecified = 0;
  for (const item of items) {
    if (item.type !== 'wound') continue;
    const wound = system(item).wound;
    if (!wound) continue;
    const modifiers = woundModifiers(wound);
    if (!modifiers?.armDisabled) continue;
    if (wound.location) disabled.add(wound.location);
    else unspecified++;
  }
  const customArms =
    state.anatomy === 'custom'
      ? state.locations?.filter((location) => location.group === 'arm' || /arm/i.test(location.id)).length
      : undefined;
  return Math.max(0, (customArms ?? 2) - disabled.size - unspecified);
}

export function validateWeaponGrip(actorState, weapon, items = actorState.items ?? []) {
  const w = system(weapon);
  if (!isHeld(weapon)) throw new RuleError('Choose a weapon or shield.');
  if (!w.properties?.natural && (!w.equipped || w.carried === false || Number(w.quantity ?? 1) < 1))
    throw new RuleError('Carry and equip a weapon with at least one remaining unit first.');
  const hands = handsUsed(weapon),
    available = availableHands(actorState, items);
  if (!Number.isInteger(hands) || hands < 0 || hands > 2)
    throw new RuleError('A weapon grip must use one or two hands.');
  const held = items.filter(
    (item) => isHeld(item) && system(item).equipped && !system(item).properties?.natural
  );
  for (const item of held) {
    const s = system(item);
    if (s.carried === false || Number(s.quantity ?? 1) < 1)
      throw new RuleError('An equipped weapon or shield is no longer in the carried inventory.');
  }
  const totalHands = held.reduce((sum, item) => sum + handsUsed(item), 0);
  if (totalHands > available || hands > available)
    throw new RuleError(
      `Equipped weapons and shields require ${Math.max(totalHands, hands)} hands; ${available} usable hands remain.`
    );
  return {
    hands,
    totalHands,
    availableHands: available,
    modifier: !w.properties?.natural && Number(w.hands) === 2 && hands === 1 ? -3 : 0,
  };
}

/** The hand crossbow still needs both hands to load (p.72). */
export function validateReload(actorState, weapon, items = actorState.items ?? []) {
  const w = system(weapon);
  if (w.category !== 'crossbow') throw new RuleError('Select a crossbow to reload.');
  validateWeaponGrip(actorState, weapon, items);
  if (w.loaded) throw new RuleError('The crossbow is already loaded.');
  if (w.jammed || Number(w.reliability) <= 0)
    throw new RuleError('Free or repair the crossbow before loading it.');
  const otherHands = items
    .filter((item) => itemId(item) !== itemId(weapon) && system(item).equipped)
    .reduce((sum, item) => sum + handsUsed(item), 0);
  if (availableHands(actorState, items) - otherHands < 2)
    throw new RuleError('Loading any crossbow requires two usable hands; free your other hand first (p.72).');
  const ammo = items.find((item) => itemId(item) === w.ammoId);
  if (!ammo || !system(ammo).isAmmo || system(ammo).carried === false || Number(system(ammo).quantity) < 1)
    throw new RuleError('Select carried ammunition with at least one remaining unit before loading.');
  return true;
}

/** Validate the complete resulting inventory before persisting any checkbox or quantity. */
export function planInventoryChange(actorState, id, patch, items = actorState.items ?? []) {
  const allowed = new Set(['equipped', 'carried', 'quantity', 'handsUsed']);
  if (!patch || Object.keys(patch).some((key) => !allowed.has(key)))
    throw new RuleError('Unknown inventory change.');
  const source = items.map(snapshot),
    item = source.find((entry) => entry.id === id);
  if (!item) throw new RuleError('The item is no longer in this inventory.');
  const changed = { ...item, ...patch };
  for (const key of ['equipped', 'carried'])
    if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean')
      throw new RuleError('Invalid inventory checkbox value.');
  if (!Number.isFinite(Number(changed.quantity)) || Number(changed.quantity) < 0)
    throw new RuleError('Item quantity must be zero or greater.');
  changed.quantity = Number(changed.quantity);
  if (Object.hasOwn(patch, 'handsUsed')) {
    const grip = Number(patch.handsUsed);
    if (
      !Number.isInteger(grip) ||
      grip < 0 ||
      grip > 2 ||
      !isHeld(item) ||
      (item.type === 'shield' && grip > 1)
    )
      throw new RuleError('Use the printed grip, one hand, or two hands; a shield uses one hand.');
    changed.handsUsed = grip;
  }
  if (changed.carried === false || changed.quantity === 0) changed.equipped = false;
  if (patch.equipped && !changed.equipped) throw new RuleError('An absent or empty item cannot be equipped.');
  if (changed.equipped && changed.quantity < 1)
    throw new RuleError('Equipping an item requires a complete unit.');
  const result = source.map((entry) => (entry.id === id ? changed : entry));
  // Unequipping an item must remain possible after injuries made the old grip invalid.
  if (changed.equipped && isHeld(changed)) validateWeaponGrip(actorState, changed, result);
  if (changed.equipped && changed.type === 'armor') armorEncumbrance(result);
  const update = {
    _id: id,
    ...Object.fromEntries(
      Object.keys({ ...patch, ...(changed.equipped !== item.equipped ? { equipped: true } : {}) }).map(
        (key) => [`system.${key}`, changed[key]]
      )
    ),
  };
  return {
    update,
    item: changed,
    drawsWeapon: isHeld(changed) && changed.equipped && !item.equipped && !changed.properties?.natural,
  };
}

export async function setInventory(actor, item, patch, { extra = false, forfeit = false } = {}) {
  owner(actor);
  return runCommand(
    'inventory',
    { actorUuid: actor.uuid, itemId: itemId(item), patch, extra, forfeit },
    {
      label: `${actor.name}: ${item.name}`,
    }
  );
}

export function registerInventory() {
  registerCommand('inventory', async ({ actorUuid, itemId: id, patch, extra, forfeit }, { user }) => {
    const actor = await authorizedActor(actorUuid, user);
    const planned = planInventoryChange(actor.system, id, patch, [...actor.items]);
    const action = planned.drawsWeapon ? actionPlan(actor, { extra, forfeit }) : { changes: {}, cost: 0 };
    return commitActor(actor, action.changes, [planned.update], () =>
      chat(
        actor,
        'Inventory',
        `<p>${e(planned.item.name)}: ${planned.item.equipped ? 'equipped' : planned.item.carried === false ? 'not carried' : 'carried'}${planned.drawsWeapon ? `; draw action, ${action.cost ?? 0} STA` : ''}.</p>`
      )
    );
  });
}
