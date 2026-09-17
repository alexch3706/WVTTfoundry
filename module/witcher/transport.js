import { SYSTEM_ID } from './config.js';
import { magicDamageRules } from './magic-effect-hooks.js';
import { RuleError, beats } from './rules.js';
import { mountedControlLoss, vehicleControlLoss, fallingDice } from './advanced-rules.js';
import { owner, prompt, input, check, dice, chat, checkHTML, escapeHTML as e, save } from './runtime.js';
import { resolveFoundryUuid } from '../foundry-compat.js';
import { directWeaponDamage } from './consequences.js';

// The core bestiary is the single source for animal stats and abilities.
export async function animalData(name) {
  const pack = game.packs.get(`${SYSTEM_ID}.bestiary`);
  if (!pack) throw new RuleError('The Core Bestiary compendium is unavailable.');
  const index = await pack.getIndex();
  const entry = index.find((row) => row.name === name);
  if (!entry) throw new RuleError(`No core animal named ${name} was found.`);
  const actor = await pack.getDocument(entry._id);
  const data = actor.toObject();
  delete data._id;
  delete data.folder;
  return data;
}
export async function deployMount(rider, item) {
  owner(rider);
  if (item.type !== 'mount') throw new RuleError('Select a mount or vehicle.');
  if (item.system.category === 'vehicle') {
    await rider.update({ 'system.mountUuid': item.uuid });
    return chat(
      rider,
      'Vehicle selected',
      `<p>${e(item.name)}. Health is tracked on its equipment sheet.</p>`
    );
  }
  let mount = item.system.mount.actorUuid ? await resolveFoundryUuid(item.system.mount.actorUuid) : null;
  if (!mount) {
    const data = await animalData(item.name);
    data.ownership = { [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
    mount = await Actor.create(data);
    await item.update({ 'system.mount.actorUuid': mount.uuid });
  }
  await rider.update({ 'system.mountUuid': mount.uuid });
  mount.sheet.render(true);
  return mount;
}
export async function getMount(rider) {
  if (!rider.system.mountUuid) return null;
  let document = await resolveFoundryUuid(rider.system.mountUuid);
  if (document?.documentName === 'Token') document = document.actor;
  if (!document) throw new RuleError('The selected mount or vehicle no longer exists.');
  const item = document.documentName === 'Item';
  const system = document.system;
  return {
    document,
    item,
    vehicle: item ? system.category === 'vehicle' : system.transport.vehicle,
    water: item ? /boat|ship|cutter/i.test(document.name) : system.transport.water,
    control: item ? system.mount.control : system.transport.control,
    ramDamage: item ? system.mount.ramDamage : system.transport.ramDamage,
    athletics: item ? system.mount.athletics : document.skillBase('athletics').total,
    hp: item ? system.mount.hp : system.hp.value,
  };
}
async function checkAthletics(actor, dc, title = 'Athletics') {
  const result = await check(actor.skillBase('athletics').total, { actor, context: { dc } });
  await chat(
    actor,
    title,
    checkHTML(result) + `<p>DC ${dc}: ${beats(result.total, dc) ? 'Success' : 'Failure'}.</p>`,
    { rolls: result.rolls }
  );
  return beats(result.total, dc);
}
export async function controlMount(rider, { attack = false, ram = false } = {}) {
  const mount = await getMount(rider);
  if (!mount) return true;
  owner(mount.document);
  if (mount.hp <= 0) throw new RuleError('This mount or vehicle cannot move.');
  const saddles = rider.items.filter((i) => i.system.carried && /saddle$/i.test(i.name));
  const bareback = !mount.vehicle && !saddles.length;
  let modifier = mount.control - (bareback ? 2 : 0);
  if (attack && saddles.some((i) => i.name === 'Cavalry Saddle')) modifier++;
  if (!attack && saddles.some((i) => i.name === 'Racing Saddle')) modifier++;
  if (ram && /cart|carriage/i.test(mount.document.name)) modifier -= 10;
  if (rider.system.transport.reinsDropped) modifier--;
  const values = await prompt(
    `${mount.document.name}: Control`,
    input('dc', 'Maneuver', {
      value: 15,
      options: { 15: 'Simple — DC 15', 20: 'Difficult — DC 20', 25: 'Very difficult — DC 25' },
    }) + input('modifier', 'Additional modifier', { value: 0 })
  );
  if (!values) throw new RuleError('Mounted action cancelled.');
  const result = await check(
    rider.skillBase(mount.water ? 'sailing' : 'riding', { modifier: modifier + Number(values.modifier) })
      .total
  );
  const success = beats(result.total, Number(values.dc));
  await chat(
    rider,
    'Control check',
    checkHTML(result) + `<p>DC ${values.dc}: ${success ? 'Success' : 'Control lost'}.</p>`,
    { rolls: result.rolls }
  );
  if (!success) await loseControl(rider, mount);
  return success;
}
async function mountDamage(mount, formula, { location = 'torso', sharedRoll } = {}) {
  if (!mount.item)
    return directWeaponDamage(
      mount.document,
      mount.document,
      {
        id: 'mountImpact',
        name: 'Mount impact',
        damage: sharedRoll !== undefined ? String(sharedRoll) : formula,
        damageTypes: ['bludgeoning'],
        properties: { natural: true, environmental: true },
      },
      { location }
    );
  const roll = sharedRoll !== undefined ? null : await dice(formula);
  const damage = sharedRoll ?? roll.total;
  await mount.document.update({ 'system.mount.hp': Math.max(0, mount.document.system.mount.hp - damage) });
  await chat(
    mount.document.actor,
    'Vehicle damage',
    `<p>${e(mount.document.name)} takes ${damage} damage.</p>`,
    { rolls: roll ? [roll] : [] }
  );
}
export async function loseControl(rider, mount) {
  if (mount.vehicle) {
    const roll = await dice('1d6'),
      result = vehicleControlLoss(roll.total);
    await chat(rider, 'Vehicle control loss', `<p>${e(result.kind)}</p>`, { rolls: [roll] });
    if (result.distance) {
      const distance = await dice(result.distance);
      await chat(
        rider,
        'Skid distance',
        `<p>${distance.total} m sideways. Resolve any collision with the ramming action.</p>`,
        { rolls: [distance] }
      );
    }
    if (result.kind === 'rollover') {
      if (mount.water) {
        await rider.update({ 'system.environment.underwater': true });
        if (!(await checkAthletics(rider, 12, 'Escape capsized vessel')))
          await rider.setCondition('suffocating');
      } else {
        const damage = await dice('5d6');
        await mountDamage(mount, '5d6', { sharedRoll: damage.total });
        await directWeaponDamage(
          rider,
          rider,
          {
            id: 'rollover',
            name: 'Vehicle rollover',
            damage: String(damage.total),
            damageTypes: ['bludgeoning'],
            properties: { natural: true, environmental: true },
          },
          { location: 'torso' }
        );
        await rider.setCondition('prone');
      }
    }
    return;
  }
  const personal = await dice('1d10'),
    animal = await dice('1d10');
  const result = mountedControlLoss(personal.total, animal.total);
  await chat(
    rider,
    'Mounted control loss',
    `<p>Rider: ${e(result.rider.kind)} (${personal.total}); mount: ${e(result.animal.kind)} (${animal.total}).</p>`,
    { rolls: [personal, animal] }
  );
  let unseated = false;
  if (result.rider.kind === 'reins') await rider.update({ 'system.transport.reinsDropped': true });
  if (
    result.rider.kind === 'bucked' &&
    !(await checkAthletics(rider, result.rider.athleticsDC, 'Stay in saddle'))
  )
    unseated = true;
  if (result.rider.kind === 'thrown') {
    unseated = true;
    const distance = await dice(result.rider.distance);
    const choice = await prompt(
      'Thrown from mount',
      `<p>Thrown ${distance.total} m.</p>` +
        input('collision', 'Hit an obstacle before landing', { type: 'checkbox' }),
      { button: 'Resolve impact' }
    );
    if (!choice) throw new RuleError('Thrown-rider impact is still pending.');
    const formula = choice.collision ? `${Math.max(1, Math.floor(distance.total))}d6` : '1d6';
    await directWeaponDamage(rider, rider, {
      id: 'thrown',
      name: 'Thrown from mount',
      damage: formula,
      damageTypes: ['bludgeoning'],
      properties: { natural: true, environmental: true },
    });
  }
  const state = result.animal;
  if (state.kind === 'spooked') {
    if (!(await checkAthletics(rider, 16, 'Stay on rearing mount'))) unseated = true;
    if (!rider.system.effects.some((e) => e.key === 'Nekker Decoction'))
      await mount.document.update({ 'system.transport.spooked': true });
  }
  if (['stumble', 'trip'].includes(state.kind)) {
    const roll = await check(mount.athletics);
    await chat(mount.document, 'Mount footing', checkHTML(roll) + `<p>DC ${state.athleticsDC}</p>`, {
      rolls: roll.rolls,
    });
    if (!beats(roll.total, state.athleticsDC)) {
      await mount.document.setCondition('prone');
      if (state.damage) {
        const leg = await dice('1d10');
        const location = leg.total <= 3 || (leg.total >= 7 && leg.total <= 8) ? 'leftLimb' : 'rightLimb';
        await mountDamage(mount, state.damage, { location });
      }
    }
  }
  if (['fall', 'faint'].includes(state.kind)) {
    await mount.document.setCondition(state.kind === 'faint' ? 'stunned' : 'prone');
    if (!unseated && !(await checkAthletics(rider, 18, 'Avoid falling mount'))) {
      const damage = await dice('2d10');
      await directWeaponDamage(rider, rider, {
        id: 'crushed',
        name: 'Falling mount',
        damage: String(damage.total),
        damageTypes: ['bludgeoning'],
        properties: { natural: true, environmental: true },
      });
      await mountDamage(mount, '2d10', { sharedRoll: damage.total });
      await rider.update({ 'system.transport.trapped': true });
    }
  }
  if (unseated) {
    await rider.setCondition('prone');
    await rider.update({ 'system.mountUuid': '' });
  }
}
export async function fall(actor) {
  owner(actor);
  const values = await prompt(
    'Fall',
    input('height', 'Metres fallen', { value: 2, min: 0 }) +
      input('grab', 'Attempt to grab a ledge', { type: 'checkbox' }) +
      input('dc', 'Ledge Athletics DC (set by GM)', { value: 15, min: 0 })
  );
  if (!values) return;
  const protection = magicDamageRules(actor.system, { source: 'falling', activeAtLanding: !values.grab });
  if (protection.preventDamage)
    return chat(
      actor,
      'Adenydd · landing',
      '<p>The active glide spell prevents falling damage on landing.</p>'
    );
  let location = 'torso';
  if (values.grab && (await checkAthletics(actor, Number(values.dc), 'Grab ledge'))) location = 'rightArm';
  const count = fallingDice(Number(values.height));
  return directWeaponDamage(
    actor,
    actor,
    {
      id: 'fall',
      name: 'Falling damage',
      damage: count ? `${count}d6` : '0',
      damageTypes: ['bludgeoning'],
      properties: {
        natural: true,
        environmental: true,
        damageSource: 'falling',
        activeAtLanding: location === 'torso',
      },
    },
    { location }
  );
}
