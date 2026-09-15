import { RuleError } from './rules.js';

/** Printed p.171. Only the speed contribution is multiplied by target weight. */
export function mountedDamage({
  distance = 0,
  galloping = false,
  weight = 'light',
  speedRoll = 0,
  baseRoll = 0,
}) {
  if (!Number.isFinite(distance) || distance < 0) throw new RuleError('Charge distance must be nonnegative.');
  const multipliers = { veryLight: 0.5, light: 1, medium: 2, heavy: 3 };
  if (!Object.hasOwn(multipliers, weight)) throw new RuleError('Invalid target weight class.');
  const dice = galloping ? 5 : Math.min(5, Math.floor(distance / 2));
  return {
    dice,
    multiplier: multipliers[weight],
    base: baseRoll,
    speed: speedRoll,
    total: Math.floor(baseRoll + speedRoll * multipliers[weight]),
  };
}
export function fallingDice(height) {
  if (!Number.isFinite(height) || height < 0) throw new RuleError('Fall height must be nonnegative.');
  return Math.floor(height / 2);
}
export function rangeDifficulty(bracket, size) {
  return bracket.dc + ({ small: 2, medium: 0, large: -2, huge: -4 }[size] ?? 0);
}
/** Graphic scatter table, printed p.152. Angles relative to forward flight. */
export function scatter(
  roll,
  distance,
  { origin = { x: 0, y: 0 }, target = { x: 0, y: -1 }, pixelsPerMeter = 1 } = {}
) {
  if (!Number.isInteger(roll) || roll < 1 || roll > 10 || !Number.isFinite(distance) || distance < 0)
    throw new RuleError('Scatter requires d10 direction and a nonnegative distance.');
  const offsets = { 1: 180, 2: -135, 3: 180, 4: 135, 5: -90, 6: 90, 7: -45, 8: 0, 9: 45, 10: 0 };
  const angle = Math.atan2(target.y - origin.y, target.x - origin.x) + (offsets[roll] * Math.PI) / 180;
  return {
    roll,
    distance,
    angle,
    x: target.x + Math.cos(angle) * distance * pixelsPerMeter,
    y: target.y + Math.sin(angle) * distance * pixelsPerMeter,
  };
}
export function mountedControlLoss(personal, mount) {
  if (![personal, mount].every((r) => Number.isInteger(r) && r >= 1 && r <= 10))
    throw new RuleError('Mounted loss requires two d10 rolls.');
  const rider =
    personal <= 3
      ? { kind: 'reins', control: -1 }
      : personal <= 7
        ? { kind: 'bucked', athleticsDC: { 4: 15, 5: 18, 6: 20, 7: 25 }[personal] }
        : {
            kind: 'thrown',
            distance: personal === 8 ? '1d6/2' : personal === 9 ? '1d6' : '1d10',
            clearDamage: '1d6',
          };
  const animal =
    mount <= 3
      ? { kind: 'refusal' }
      : mount === 4
        ? { kind: 'spooked', riderDC: 16, animalHandlingDC: 18 }
        : mount <= 6
          ? { kind: 'stumble', athleticsDC: mount === 5 ? 14 : 18 }
          : mount <= 8
            ? { kind: 'trip', athleticsDC: mount === 7 ? 15 : 20, damage: mount === 7 ? '1d10' : '2d10' }
            : { kind: mount === 9 ? 'fall' : 'faint', riderDC: 18, damage: '2d10', escapeDC: 25 };
  return { rider, animal };
}
export function vehicleControlLoss(roll) {
  if (!Number.isInteger(roll) || roll < 1 || roll > 6)
    throw new RuleError('Vehicle control loss requires 1d6.');
  return roll <= 2
    ? { kind: 'skid' }
    : roll <= 4
      ? { kind: 'majorSkid', distance: '1d10*2' }
      : { kind: 'rollover', distance: '1d10*3', damage: '5d6', waterEscapeDC: 12 };
}
export function heatFactor(items) {
  return items.some((i) => i.equipped && i.type === 'armor' && ['medium', 'heavy'].includes(i.armorClass))
    ? 0.5
    : 2 / 3;
}
export function adrenalineCost(dice, pool, stamina) {
  if (!Number.isInteger(dice) || dice < 0 || dice > pool)
    throw new RuleError('Invalid adrenaline expenditure.');
  const cost = dice * 10;
  if (cost > stamina) throw new RuleError('Adrenaline costs 10 STA per die.');
  return { pool: pool - dice, stamina: stamina - cost, dice };
}
