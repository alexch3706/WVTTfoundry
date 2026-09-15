import { SYSTEM_ID, CONDITIONS } from './config.js';
import { RuleError, beats, criticalHealingDays, hitLocations, resolveDamage } from './rules.js';
import { immuneTo, creatureRegeneration } from './monster-rules.js';
import { allocateMaterials, craftingRecovery, repairDifficulty, materialKey } from './crafting.js';
import { actorSnapshot, itemSnapshot } from './documents.js';
import { planDamageChanges, attack } from './combat.js';
import {
  owner,
  prompt,
  input,
  check,
  dice,
  chat,
  checkHTML,
  escapeHTML as e,
  actionPlan,
  commitActor,
  serial,
  save,
  actorFromUuid,
  errorNotice,
} from './runtime.js';
import { isPrimaryActiveGm, resolveFoundryUuid } from '../foundry-compat.js';
import { deployMount } from './transport.js';

const now = () => game.time.worldTime;
const has = (actor, key) => actor.system.conditions.includes(key);
const active = (actor, key) => actor.system.effects.find((x) => x.key === key);
const targetFor = (actor) => [...game.user.targets][0]?.actor ?? actor;
const effect = (key, duration, details = {}) => ({
  id: foundry.utils.randomID(),
  key,
  expires: duration ? now() + duration * 3 : 0,
  ...details,
});
const positiveProps = (props) =>
  Object.fromEntries(
    Object.entries(props).filter(([, value]) => value !== false && value !== 0 && value !== '')
  );

export async function turnAction(actor, key, item) {
  owner(actor);
  return serial(actor.uuid, async () => {
    if (key === 'tick') {
      if (!game.user.isGM) throw new RuleError('The active GM processes recurring effects.');
      return tickActor(actor, `manual:${foundry.utils.randomID()}`);
    }
    if (key === 'stand') {
      await actor.setCondition('prone', false);
      await chat(actor, 'Stand up', '<p>Movement spent standing; your action remains available (p.163).</p>');
      return;
    }
    if (key === 'endCondition') return endCondition(actor);
    const plan = actionPlan(actor, {
      full: ['recover', 'aim', 'activeDodge', 'run'].includes(key),
      recovery: key === 'recover',
    });
    const changes = { ...plan.changes };
    let text = '';
    if (key === 'recover') {
      const recovered = actor.system.derived.rec + (active(actor, 'Tawny Owl') ? 2 : 0);
      changes['system.sta.value'] = Math.min(actor.system.sta.max, actor.system.sta.value + recovered);
      if (has(actor, 'unconscious'))
        changes['system.unconsciousRecovery'] = actor.system.unconsciousRecovery + recovered;
      text = `Recover ${recovered} STA.`;
    } else if (key === 'aim') {
      changes['system.combat.aim'] = Math.min(3, actor.system.combat.aim + 1);
      text = `Ranged aiming bonus: +${changes['system.combat.aim']}.`;
    } else if (key === 'unjam') {
      if (!item?.system.jammed) throw new RuleError('This weapon is not jammed or stuck.');
      await commitActor(actor, changes, [{ _id: item.id, 'system.jammed': false }]);
      await chat(actor, 'Weapon freed', `<p>${e(item.name)} is usable again.</p>`);
      return;
    } else if (key === 'activeDodge') {
      changes['system.conditions'] = [...new Set([...actor.system.conditions, 'activelyDodging'])];
      text = 'Melee attackers take −2; additional defenses cost no STA until your next turn.';
    } else if (key === 'run')
      text = `Run up to ${Math.ceil(actor.system.derived.run / 2) * 2} m on a 2 m grid.`;
    else if (key === 'reload') {
      if (item?.system.category !== 'crossbow') throw new RuleError('Select a crossbow to reload.');
      if (item.system.loaded) throw new RuleError('The crossbow is already loaded.');
      await commitActor(actor, changes, [{ _id: item.id, 'system.loaded': true }]);
      await chat(actor, 'Reload', `<p>${e(item.name)} is loaded.</p>`);
      return;
    } else throw new RuleError('Unknown turn action.');
    await commitActor(actor, changes);
    await chat(actor, key, `<p>${e(text)}</p>`);
    if (key === 'recover' && has(actor, 'stunned')) await save(actor, 'stun');
  });
}

async function endCondition(actor) {
  const choices = Object.fromEntries(actor.system.conditions.map((k) => [k, CONDITIONS[k]]));
  const values = await prompt('End a condition', input('condition', 'Condition', { options: choices }));
  if (!values) return;
  const key = values.condition,
    plan = actionPlan(actor, {
      full: ['fire', 'blinded', 'stunned', 'unconscious'].includes(key),
      recovery: ['stunned', 'unconscious'].includes(key),
    });
  if (['stunned', 'unconscious'].includes(key)) {
    await commitActor(actor, plan.changes);
    return save(actor, 'stun');
  }
  const specs = {
    poison: ['endurance', active(actor, 'Black Venom') ? 16 : active(actor, 'Toxicity') ? 18 : 15],
    bleeding: ['firstAid', 15],
    frozen: ['physique', 16],
    hallucinating: ['deduction', 15],
  };
  if (!specs[key] && !['fire', 'blinded'].includes(key))
    throw new RuleError('Use the corresponding escape, recovery, or treatment action for this condition.');
  const result = specs[key]
    ? await check(actor.skillBase(specs[key][0], { modifier: plan.modifier }).total)
    : null;
  await commitActor(actor, plan.changes);
  if (!result || beats(result.total, specs[key][1])) await actor.setCondition(key, false);
  await chat(
    actor,
    'End ' + CONDITIONS[key],
    result
      ? checkHTML(result) +
          `<p>DC ${specs[key][1]}. ${beats(result.total, specs[key][1]) ? 'Condition ended.' : 'Condition continues.'}</p>`
      : '<p>Full round spent clearing the effect.</p>',
    { rolls: result?.rolls ?? [] }
  );
}

export async function treat(patient, woundItem) {
  owner(patient);
  const candidates = game.actors.filter((a) => a.isOwner);
  const values = await prompt(
    'Medical treatment',
    input('healer', 'Healer', {
      value: patient.id,
      options: Object.fromEntries(candidates.map((a) => [a.id, a.name])),
    }) +
      input('kind', 'Treatment', {
        options: woundItem
          ? {
              stabilize: 'Stabilize critical wound (First Aid)',
              treat: 'Treat critical wound (Healing Hands)',
            }
          : {
              firstAid: 'Begin natural healing (First Aid)',
              healingHands: 'Begin natural healing (Healing Hands)',
              death: 'Stabilize Death State (First Aid)',
            },
      }) +
      input('modifier', 'Situational modifier', { value: 0 }) +
      input('rounds', 'Rounds spent treating this wound', { value: 0, min: 0 }),
    { button: 'Treat' }
  );
  if (!values) return;
  const healer = owner(game.actors.get(values.healer));
  return serial(healer.uuid, async () => {
    const plan = actionPlan(healer),
      kind = values.kind,
      skill = ['healingHands', 'treat'].includes(kind) ? 'healingHands' : 'firstAid';
    if (
      skill === 'healingHands' &&
      !healer.system.customSkills.some((s) => s.id === 'healingHands' || s.name === 'Healing Hands') &&
      !healer.system.professionRanks.healingHands
    )
      throw new RuleError('This healer needs the Doctor’s Healing Hands skill.');
    let dc = 14;
    if (kind === 'death') {
      if (patient.system.hp.value > 0) throw new RuleError('The patient is not in Death State.');
      dc = Math.abs(patient.system.hp.value);
    }
    if (woundItem) {
      const wound = woundItem.system.wound;
      if (wound.fatal) throw new RuleError('This fatal wound cannot be stabilized or treated.');
      dc = { simple: 12, complex: 14, difficult: 16, deadly: 18 }[wound.severity];
      if (kind === 'treat') {
        const rounds = { simple: 2, complex: 4, difficult: 6, deadly: 8 }[wound.severity];
        const total = wound.turnsTreated + Number(values.rounds || 1);
        if (total < rounds) {
          await commitActor(healer, plan.changes);
          await woundItem.update({ 'system.wound.turnsTreated': total });
          await chat(
            healer,
            'Treatment',
            `<p>${total} / ${rounds} rounds. Roll Healing Hands after completing the required time.</p>`
          );
          return;
        }
      }
    }
    const result = await check(
      healer.skillBase(skill, { stat: 'cra', modifier: Number(values.modifier) + plan.modifier }).total
    );
    await commitActor(healer, plan.changes);
    const success = beats(result.total, dc);
    if (success) {
      if (kind === 'death')
        await patient.update({ 'system.hp.value': 1, 'system.deathSaves': 0, 'system.pendingDeathSaves': 0 });
      else if (woundItem) {
        const severity = woundItem.system.wound.severity;
        await woundItem.update({
          'system.wound.treatment': kind === 'treat' ? 'treated' : 'stabilized',
          'system.wound.turnsTreated': 0,
          'system.wound.daysRemaining':
            kind === 'treat' ? (criticalHealingDays(patient.system.derived.stats.body, severity) ?? 0) : 0,
        });
        if (['bleeding', 'poison', 'suffocating'].some((c) => woundItem.system.wound[c])) {
          const remaining = patient.items.filter(
            (i) => i.type === 'wound' && i.id !== woundItem.id && i.system.wound.treatment === 'untreated'
          );
          for (const c of ['bleeding', 'poison', 'suffocating'])
            if (woundItem.system.wound[c] && !remaining.some((i) => i.system.wound[c]))
              await patient.setCondition(c, false);
        }
      } else
        await patient.update({
          'system.healingEnabled': true,
          'system.healingBonus': kind === 'healingHands' ? 3 : 0,
        });
    }
    await chat(
      healer,
      `Treatment: ${patient.name}`,
      checkHTML(result) + `<p>DC ${dc}: ${success ? 'Successful.' : 'Failed.'}</p>`,
      { rolls: result.rolls }
    );
  });
}

function stock(actor) {
  return actor.items.map((i) => ({
    ...itemSnapshot(i),
    sourceUuid: i._stats?.compendiumSource ?? i.flags.core?.sourceId,
  }));
}
function hasTool(actor, name) {
  return actor.items.some((i) => i.system.carried && i.system.quantity > 0 && i.name === name);
}
async function craftAttempt(actor, diagram, { repairItem = null } = {}) {
  owner(actor);
  if (diagram?.type !== 'diagram') throw new RuleError('Select a crafting diagram or alchemy formula.');
  const d = diagram.system,
    alchemy = d.skill === 'alchemy';
  if (!hasTool(actor, alchemy ? 'Alchemy Set' : 'Crafting Tools'))
    throw new RuleError(`A carried ${alchemy ? 'Alchemy Set' : 'Crafting Tools'} is required.`);
  if (!d.productUuid && !repairItem) throw new RuleError('The recipe needs a valid product compendium link.');
  const materials = repairItem ? d.materials.map((m) => ({ ...m, quantity: 1 })) : d.materials;
  if (!materials.length) throw new RuleError('This recipe has no component requirements.');
  const used = allocateMaterials(materials, stock(actor));
  const metal = materials.some((m) => /iron|steel|silver|gold|meteorite|dimeritium/i.test(m.name));
  const values = await prompt(
    repairItem ? 'Repair equipment' : 'Craft',
    `<p>${e(diagram.name)} · ${e(d.craftTime)}</p><ul>${used.map((i) => `<li>${e(i.name)} × ${i.quantity}</li>`).join('')}</ul>` +
      input('written', 'Written recipe available (+2)', { type: 'checkbox', checked: d.carried !== false }) +
      input('forge', 'Forge available', { type: 'checkbox', checked: hasTool(actor, 'Tinker’s Forge') }) +
      input('time', 'Required crafting time has elapsed', { type: 'checkbox' }) +
      input('modifier', 'Other modifiers', { value: 0 }),
    { button: 'Complete crafting' }
  );
  if (!values) return;
  if (!values.time) throw new RuleError('Complete the recipe’s crafting time first.');
  if (metal && !values.forge) throw new RuleError('Recipes with metal components require a forge (p.127).');
  if (!values.written && !d.memorized)
    throw new RuleError('The recipe must be memorized or physically available.');
  const dc = repairItem ? repairDifficulty(d, repairItem.system.attachments.length) : d.craftDC;
  const result = await check(
    actor.skillBase(d.skill, { modifier: (values.written ? 2 : 0) + Number(values.modifier) }).total
  );
  const success = beats(result.total, dc);
  const updates = used.map((i) => ({ _id: i.id, 'system.quantity': i.after }));
  const created = [];
  if (success && !repairItem) {
    const product = await resolveFoundryUuid(d.productUuid);
    if (!product) throw new RuleError('The product compendium entry is unavailable.');
    const data = product.toObject();
    delete data._id;
    data.system.quantity = d.productQuantity;
    data.system.equipped = false;
    created.push(...(await actor.createEmbeddedDocuments('Item', [data])));
  }
  if (success && repairItem) {
    const update = { _id: repairItem.id };
    if (repairItem.type === 'armor')
      update['system.sp'] = Object.fromEntries(
        repairItem.system.coverage.map((id) => [id, repairItem.system.stoppingPower])
      );
    else update['system.reliability'] = repairItem.system.maxReliability;
    updates.push(update);
  }
  try {
    await commitActor(actor, {}, updates);
  } catch (error) {
    if (created.length)
      await actor.deleteEmbeddedDocuments(
        'Item',
        created.map((i) => i.id)
      );
    throw error;
  }
  await chat(
    actor,
    repairItem ? 'Repair' : 'Crafting',
    checkHTML(result) + `<p>DC ${dc}: ${success ? 'Completed.' : 'Failed; components consumed.'}</p>`,
    { rolls: result.rolls }
  );
  if (!success) {
    const recover = await prompt('Recover components', '<p>One immediate recovery attempt is allowed.</p>', {
      button: 'Recovery roll',
    });
    if (!recover) return;
    const roll = await check(actor.skillBase(d.skill).total);
    const recovered = craftingRecovery(used, { alchemy, success: beats(roll.total, dc) });
    if (alchemy && recovered.length) {
      const choice = await prompt(
        'Recovered substance',
        input('substance', 'Choose one pure substance', {
          options: Object.fromEntries(recovered.map((i) => [i.name, i.name])),
        }),
        { button: 'Recover' }
      );
      if (choice)
        await actor.createEmbeddedDocuments('Item', [
          {
            name: choice.substance,
            type: 'component',
            system: { substance: choice.substance, category: 'pureSubstance', quantity: 1, weight: 0.1 },
          },
        ]);
    } else if (recovered.length)
      await actor.updateEmbeddedDocuments(
        'Item',
        recovered.map((i) => ({
          _id: i.id,
          'system.quantity': actor.items.get(i.id).system.quantity + i.quantity,
        }))
      );
    await chat(
      actor,
      'Crafting recovery',
      checkHTML(roll) + `<p>DC ${dc}: ${recovered.length ? 'Materials recovered.' : 'No recovery.'}</p>`,
      { rolls: roll.rolls }
    );
  }
}
export const craft = (actor, diagram) => serial(actor.uuid, () => craftAttempt(actor, diagram));
export async function repair(actor, item) {
  if (!['weapon', 'armor', 'shield'].includes(item?.type))
    throw new RuleError('Only weapons, armor and shields use this repair action.');
  let diagram = actor.items.find(
    (i) => i.type === 'diagram' && materialKey(i.system.productName) === materialKey(item.name)
  );
  if (!diagram) {
    const pack = game.packs.get(`${SYSTEM_ID}.diagrams`);
    const index = await pack.getIndex({ fields: ['system.productName'] });
    const entry = index.find((i) => materialKey(i.system.productName) === materialKey(item.name));
    if (entry) diagram = await pack.getDocument(entry._id);
  }
  if (!diagram) throw new RuleError('No matching repair recipe was found.');
  return serial(actor.uuid, () => craftAttempt(actor, diagram, { repairItem: item }));
}

export async function enhance(actor, enhancement) {
  owner(actor);
  return serial(actor.uuid, async () => {
    if (enhancement.system.quantity < 1) throw new RuleError('No enhancement remains.');
    const rune = enhancement.system.category === 'rune',
      glyph = enhancement.system.category === 'glyph';
    const eligible = actor.items.filter(
      (i) => i.type === (rune ? 'weapon' : 'armor') && i.system.attachments.length < i.system.enhancements
    );
    if (!eligible.length) throw new RuleError('No suitable item has a free enhancement slot.');
    const values = await prompt(
      'Apply enhancement',
      input('target', 'Equipment', { options: Object.fromEntries(eligible.map((i) => [i.id, i.name])) }) +
        input('modifier', 'Crafting modifier', { value: 0 }),
      { button: 'Apply' }
    );
    if (!values) return;
    const target = actor.items.get(values.target),
      s = target.system,
      enh = enhancement.system;
    if (!rune && !glyph && !hasTool(actor, 'Crafting Tools'))
      throw new RuleError('Crafting Tools are required.');
    const plan = actionPlan(actor, { full: true });
    const result =
      !rune && !glyph
        ? await check(
            actor.skillBase('crafting', { modifier: Number(values.modifier) + plan.modifier }).total
          )
        : null;
    if (result && !beats(result.total, 14)) {
      await commitActor(actor, plan.changes);
      await chat(
        actor,
        'Enhancement failed',
        checkHTML(result) + '<p>DC 14; the enhancement can be tried again.</p>',
        { rolls: result.rolls }
      );
      return;
    }
    const update = {
      _id: target.id,
      'system.attachments': [
        ...s.attachments,
        { id: enhancement.id, name: enhancement.name, category: enh.category, system: enh.toObject() },
      ],
      'system.weight': s.weight + enh.weight,
      'system.properties': { ...s.properties, ...positiveProps(enh.properties) },
      'system.resistances': [...new Set([...s.resistances, ...enh.resistances])],
      'system.skillBonuses': [...s.skillBonuses, ...enh.skillBonuses],
    };
    if (!rune && !glyph) {
      update['system.stoppingPower'] = s.stoppingPower + enh.stoppingPower;
      update['system.sp'] = Object.fromEntries(
        s.coverage.map((id) => [id, (s.sp[id] ?? s.stoppingPower) + enh.stoppingPower])
      );
    }
    await commitActor(actor, plan.changes, [
      update,
      { _id: enhancement.id, 'system.quantity': enh.quantity - 1 },
    ]);
    await chat(
      actor,
      'Enhancement applied',
      `<p>${e(enhancement.name)} → ${e(target.name)}</p>` + (result ? checkHTML(result) : ''),
      { rolls: result?.rolls ?? [] }
    );
  });
}

export async function useItem(actor, item) {
  owner(actor);
  if (!item || item.system.quantity < 1) throw new RuleError('No item remains to use.');
  if (item.type === 'mount') return deployMount(actor, item);
  const throwing = {
    'Acid Solution': { damage: '2d6', properties: { contactAblation: true, area: 2, cone: true } },
    'Bredan’s Fury': { damage: '2d6', properties: { allLocations: true, area: 2 } },
    'Talgar’s Tears': { damage: '0', properties: { freeze: 100, area: 2, cone: true } },
    'Zerrikanian Fire': { damage: '0', properties: { fire: 100, area: 2, cone: true } },
    'Alchemical Adhesive': { damage: '0', properties: { adhesive: true } },
  }[item.name];
  if (throwing) {
    const weapon = {
      ...itemSnapshot(item),
      ...throwing,
      type: 'weapon',
      category: 'thrown',
      skill: 'athletics',
      stat: 'dex',
      reliability: 1,
      hands: 1,
      accuracy: 0,
      rof: 1,
      rangeBodyMultiplier: 2,
      consumable: true,
      damageTypes: ['elemental'],
    };
    return attack(actor, item, { weapon });
  }
  const target = targetFor(actor);
  if (!target.isOwner) {
    return chat(
      actor,
      `${item.name} → ${target.name}`,
      `<p>${e(item.system.effectText)}</p><button type="button" data-witcher-use>Apply item (GM)</button>`,
      { flags: { kind: 'itemUse', actorUuid: actor.uuid, targetUuid: target.uuid, itemId: item.id } }
    );
  }
  return serial(actor.uuid, () => applyItem(actor, target, item));
}

const POTION_MODIFIERS = {
  'Full Moon': { hp: 30 },
  'Petri’s Filter': { spellCasting: 2, hexWeaving: 2, ritualCrafting: 2 },
  Thunderbolt: { damage: 3 },
  'Fiend Decoction': { encMultiplier: 2 },
  'Nekker Decoction': { riding: 3, athletics: 3 },
};
const MUTAGENS = {
  'Griffin Mutagen': { meleeBonus: 2 },
  'Katakan Mutagen': { ref: 1 },
  'Nekker Mutagen': { meleeBonus: 1 },
  'Werewolf Mutagen': { meleeBonus: 3 },
  'Wyvern Mutagen': { meleeBonus: 3 },
  'Arachas Mutagen': { hp: 5 },
  'Fiend Mutagen': { body: 1 },
  'Grave Hag Mutagen': { hp: 5 },
  'Noonwraith Mutagen': { hp: 10 },
  'Rock Troll Mutagen': { hp: 10 },
  'Golem Mutagen': { vigor: 2 },
  'Siren Mutagen': { vigor: 1 },
};
async function applyItem(actor, target, item) {
  owner(actor);
  owner(target);
  if (item.system.quantity < 1) throw new RuleError('The item has already been consumed.');
  if (item.type !== 'alchemical')
    return chat(actor, item.name, `<p>${e(item.system.effectText || item.system.notes)}</p>`);
  const plan = actionPlan(actor),
    s = item.system,
    name = item.name;
  const effects = foundry.utils.deepClone(target.system.effects),
    conditions = new Set(target.system.conditions),
    changes = {},
    rolls = [];
  const addEffect = (key, duration, data = {}) => {
    const index = effects.findIndex((x) => x.key === key);
    const value = effect(key, duration, data);
    if (index >= 0) effects[index] = value;
    else effects.push(value);
  };
  const resist = async (skill, dc) => {
    const r = await check(target.skillBase(skill).total);
    rolls.push(...r.rolls);
    return beats(r.total, dc);
  };
  let consumed = 1,
    detail = '';
  if (['potion', 'decoction'].includes(s.category)) {
    if (name === 'White Honey') {
      for (let i = effects.length - 1; i >= 0; i--)
        if (effects[i].potion) {
          if (effects[i].temporaryHp)
            changes['system.hp.value'] =
              (changes['system.hp.value'] ?? target.system.hp.value) - effects[i].temporaryHp;
          effects.splice(i, 1);
        }
      changes['system.toxicity.value'] = 0;
    } else if (target.system.race !== 'witcher' && !(await resist('endurance', 18))) {
      conditions.add('poison');
      detail = 'Failed non-witcher Endurance check; poisoned without gaining the potion effect.';
    } else {
      if (active(target, name))
        throw new RuleError('This potion effect is already active; identical effects do not stack.');
      addEffect(name, s.duration, {
        potion: true,
        toxicity: s.toxicity,
        modifiers: POTION_MODIFIERS[name] ?? {},
        ...(name === 'Full Moon' ? { temporaryHp: 30 } : {}),
      });
      if (name === 'Full Moon') changes['system.hp.value'] = target.system.hp.value + 30;
      if (name === 'Golden Oriole') conditions.delete('poison');
      if (name === 'Noon Wraith Decoction')
        for (const key of ['stunned', 'blinded', 'prone']) conditions.delete(key);
      const toxicity = effects.filter((x) => x.potion).reduce((n, x) => n + x.toxicity, 0);
      changes['system.toxicity.value'] = toxicity;
      const iron = target.system.professionRanks.ironStomach ?? 0;
      const limit = iron >= 10 ? 150 : 100 + (iron ? 5 + Math.floor((iron - 1) / 2) * 5 : 0);
      if (toxicity > limit) {
        conditions.add('poison');
        addEffect('Toxicity', 0, { lastPotion: name });
      }
    }
  } else if (s.category === 'mutagen') {
    if (target.system.race !== 'witcher') {
      conditions.add('poison');
      addEffect('Mutagen Poison', 0, { dc: 18 });
    } else {
      if (effects.filter((x) => x.mutagen).length >= 2)
        throw new RuleError('A witcher can have two permanent mutagens; they cannot be removed (p.251).');
      const prepared = await prompt(
        'Prepare mutagen',
        '<p>Processing and consuming a mutagen takes one hour.</p>',
        { button: 'Complete preparation' }
      );
      if (!prepared) return;
      const r = await check(actor.skillBase('alchemy').total);
      rolls.push(...r.rolls);
      if (beats(r.total, s.craftDC)) addEffect(name, 0, { mutagen: true, modifiers: MUTAGENS[name] ?? {} });
      else detail = 'Alchemy preparation failed.';
    }
  } else if (s.category === 'oil') {
    const weapons = actor.items.filter((i) => i.type === 'weapon' && i.system.equipped);
    const choice = await prompt(
      'Apply blade oil',
      input('weapon', 'Weapon', { options: Object.fromEntries(weapons.map((i) => [i.id, i.name])) }),
      { button: 'Apply' }
    );
    if (!choice) return;
    await commitActor(actor, plan.changes, [
      { _id: choice.weapon, 'system.oil': { name, expires: now() + 1800 } },
      { _id: item.id, 'system.quantity': s.quantity - 1 },
    ]);
    await chat(actor, name, '<p>Blade oil applied for 30 minutes.</p>');
    return;
  } else {
    if (name === 'Black Venom') {
      conditions.add('poison');
      addEffect(name, 0, { dc: 16 });
    } else if (name === 'Smelling Salts') {
      conditions.delete('stunned');
      conditions.delete('unconscious');
      consumed = 1 / 25;
    } else if (name === 'Clotting Powder') {
      const r = await dice('2d10');
      rolls.push(r);
      conditions.delete('bleeding');
      addEffect(name, r.total, { resumeBleeding: has(target, 'bleeding') });
    } else if (name === 'Numbing Herbs') {
      const r = await dice('2d10');
      rolls.push(r);
      addEffect(name, r.total, { painRelief: 2 });
    } else if (name === 'Sterilizing Fluid') addEffect(name, 0, { modifiers: { rec: 2 }, healingDays: -2 });
    else if (name === 'Wive’s Tears Potion' || name === 'Wives’ Tears Potion')
      conditions.delete('intoxicated');
    else if (name === 'Hallucinogen') {
      const r = await dice('1d10');
      rolls.push(r);
      if (!(await resist('endurance', 15))) {
        conditions.add('hallucinating');
        addEffect(name, r.total, { removeCondition: 'hallucinating' });
      }
    } else if (name === 'Chloroform') {
      const r = await dice('1d10');
      rolls.push(r);
      if (r.total >= target.system.derived.stun - 2) {
        conditions.add('stunned');
        conditions.add('unconscious');
        addEffect(name, 0, { chloroform: true });
      }
      consumed = 1 / 25;
    } else if (name === 'Pantagran’s Elixir') {
      const r = await dice('1d6');
      rolls.push(r);
      addEffect(name, r.total * 600, { modifiers: { resistCoercion: -2 } });
    } else if (name === 'Perfume Potion') {
      const r = await dice('1d10');
      rolls.push(r);
      if (!(await resist('endurance', 16))) {
        conditions.add('intoxicated');
        addEffect(name, r.total * 1200, { removeCondition: 'intoxicated', toxicity: 25, potion: true });
      }
    } else if (name === 'Succubus’ Breath')
      addEffect(name, 0, {
        modifiers: { seduction: 2 },
        notes: 'Applied to skin; ingested use applies −5 resistance to seduction instead (p.88).',
      });
    else if (name === 'Base Powder') {
      const wounds = target.items.filter((i) => i.type === 'wound' && i.name === 'Torn Stomach');
      if (wounds.length)
        await target.updateEmbeddedDocuments(
          'Item',
          wounds.map((i) => ({ _id: i.id, 'system.wound.damagePerTurn': 0 }))
        );
      detail = 'One dose of acid neutralized; Torn Stomach acid damage stopped.';
    } else if (name === 'Fisstech') {
      if (!(await resist('endurance', 18))) addEffect('Fisstech Addiction', 0, { addiction: true });
      const r = await check(target.skillBase('endurance').total);
      rolls.push(...r.rolls);
      if (r.total <= 16) {
        conditions.add('stunned');
        addEffect('Fisstech', 600, { painRelief: 4 });
        if (r.total < 10) {
          conditions.add('unconscious');
          addEffect('Fisstech Unconscious', 5, { removeCondition: 'unconscious' });
        }
      }
    } else if (
      [
        'Acid Solution',
        'Bredan’s Fury',
        'Talgar’s Tears',
        'Zerrikanian Fire',
        'Alchemical Adhesive',
      ].includes(name)
    )
      throw new RuleError('Use the alchemical attack action to throw this item.');
    else if (name === 'Quick Fire') addEffect(name, 0, { flammable: 50 });
    else if (name === 'Adda’s Tomb') {
      const r = await dice('1d10');
      rolls.push(r);
      detail = `Perishables preserved for ${r.total} days. A human-sized corpse requires two doses.`;
    } else if (name === 'Poisoner’s Friend') {
      addEffect(name, 0, { poisonDetectionDC: 20 });
      detail = 'Poison detection DC becomes 20.';
    } else if (name === 'Invisible Ink') detail = 'Message written; one turn of heat reveals it.';
    else throw new RuleError(`No use procedure registered for ${name}.`);
  }
  changes['system.effects'] = effects;
  changes['system.conditions'] = [...conditions];
  if (target.uuid === actor.uuid)
    await commitActor(actor, { ...plan.changes, ...changes }, [
      { _id: item.id, 'system.quantity': Math.max(0, s.quantity - consumed) },
    ]);
  else {
    await target.update(changes);
    await commitActor(actor, plan.changes, [
      { _id: item.id, 'system.quantity': Math.max(0, s.quantity - consumed) },
    ]);
  }
  await chat(actor, `${name} → ${target.name}`, `<p>${e(s.effectText)}</p><p>${e(detail)}</p>`, { rolls });
}

export async function tickActor(actor, key) {
  if (!isPrimaryActiveGm()) return;
  if (actor.system.combat.lastEffectTurn === key || has(actor, 'dead')) return;
  const state = actorSnapshot(actor),
    results = [];
  let direct = 0;
  if (has(actor, 'fire'))
    for (const location of hitLocations(state))
      results.push(
        resolveDamage(
          { raw: 5, type: 'fire', properties: { fixedAblation: 1 } },
          state,
          location,
          state.items
        )
      );
  const poisonImmune = active(actor, 'Golden Oriole') || immuneTo(state, 'poison');
  if (has(actor, 'poison') && !poisonImmune) direct += 3;
  if (has(actor, 'bleeding') && !active(actor, 'Clotting Powder') && !immuneTo(state, 'bleeding')) {
    const resistant =
      state.naturalResistances.includes('bleeding') ||
      state.resistances.includes('bleeding') ||
      state.items.some((i) => i.type === 'armor' && i.equipped && i.resistances.includes('bleeding'));
    direct += Math.floor((2 + (actor.system.derived.mods.bleedingDamage ?? 0)) * (resistant ? 0.5 : 1));
  }
  if (has(actor, 'suffocating') && !immuneTo(state, 'suffocating')) direct += 3;
  const woundUpdates = [];
  let saves = 0;
  for (const item of actor.items.filter((i) => i.type === 'wound')) {
    const w = item.system.wound,
      age = w.ageRounds + 1;
    direct +=
      w.treatment === 'untreated'
        ? w.damagePerTurn
        : w.treatment === 'stabilized'
          ? w.stabilizedDamagePerTurn
          : 0;
    const period =
      w.treatment === 'untreated' ? w.stunEvery : w.treatment === 'stabilized' ? w.stabilizedStunEvery : 0;
    if (period && age % period === 0) saves++;
    woundUpdates.push({ _id: item.id, 'system.wound.ageRounds': age });
  }
  const planned = planDamageChanges(actor, results);
  planned.actor['system.hp.value'] -= direct;
  // Being on fire also damages held weapons every round, even if armor stopped it.
  if (has(actor, 'fire'))
    for (const i of actor.items.filter(
      (i) => i.type === 'weapon' && i.system.equipped && !i.system.properties.natural
    ))
      planned.items.push({ _id: i.id, 'system.reliability': Math.max(0, i.system.reliability - 1) });
  let regen = (active(actor, 'Troll Decoction') ? 5 : 0) + creatureRegeneration(state);
  if (active(actor, 'Swallow') && !actor.system.combat.hitThisRound) regen += 3;
  if (active(actor, 'Grave Hag Decoction')) regen += active(actor, 'Grave Hag Decoction').kills * 2 || 0;
  planned.actor['system.hp.value'] = Math.min(actor.system.hp.max, planned.actor['system.hp.value'] + regen);
  if (actor.system.hp.value <= 0 || planned.actor['system.hp.value'] <= 0)
    planned.actor['system.pendingDeathSaves'] = actor.system.pendingDeathSaves + 1;
  planned.actor['system.combat.lastEffectTurn'] = key;
  planned.actor['system.combat.hitThisRound'] = false;
  // Tick damage does not free a stunned victim unless an actual damaging effect hit them.
  if (!results.length && !direct) planned.actor['system.conditions'] = actor.system.conditions;
  await commitActor(actor, planned.actor, [...planned.items, ...woundUpdates]);
  if (direct || results.length || regen)
    await chat(
      actor,
      'Round effects',
      `<p>${results.reduce((n, r) => n + r.damage, 0)} fire damage; ${direct} damage ignoring armor; ${regen} HP regeneration.</p>`
    );
  for (let i = 0; i < saves; i++) await save(actor, 'stun');
  await expireEffects(actor);
}
export async function expireEffects(actor) {
  const expired = actor.system.effects.filter((x) => x.expires && x.expires <= now());
  if (!expired.length) return;
  const effects = actor.system.effects.filter((x) => !expired.some((e) => e.id === x.id));
  const conditions = new Set(actor.system.conditions);
  let hp = actor.system.hp.value;
  for (const effect of expired) {
    if (effect.removeCondition) conditions.delete(effect.removeCondition);
    if (effect.resumeBleeding) conditions.add('bleeding');
    if (effect.temporaryHp) hp -= effect.temporaryHp;
  }
  const toxicity = effects.filter((x) => x.potion).reduce((n, x) => n + (x.toxicity || 0), 0);
  await actor.update({
    'system.effects': effects,
    'system.conditions': [...conditions],
    'system.hp.value': hp,
    'system.toxicity.value': toxicity,
  });
}
export function registerActivities() {
  Hooks.on('updateCombat', (combat, changes) => {
    if (!isPrimaryActiveGm() || !('turn' in changes || 'round' in changes) || !combat.started) return;
    const actor = combat.combatant?.actor;
    if (!actor) return;
    serial(actor.uuid, async () => {
      const conditions = actor.system.conditions.filter((c) => !['staggered', 'activelyDodging'].includes(c));
      await actor.update({
        'system.conditions': conditions,
        'system.effects': actor.system.effects.filter((e) => !e.untilTurn),
      });
      await tickActor(actor, `${combat.id}:${combat.round}:${combat.turn}`);
    }).catch(errorNotice);
  });
  Hooks.on('updateWorldTime', () => {
    if (!isPrimaryActiveGm()) return;
    const actors = new Map(game.actors.map((a) => [a.uuid, a]));
    for (const token of canvas.tokens?.placeables ?? [])
      if (token.actor) actors.set(token.actor.uuid, token.actor);
    for (const actor of actors.values()) serial(actor.uuid, () => expireEffects(actor)).catch(errorNotice);
  });
  Hooks.on('renderChatMessageHTML', (message, html) =>
    html.querySelector('[data-witcher-use]')?.addEventListener('click', () =>
      serial('gm-item-use', async () => {
        if (!game.user.isGM) throw new RuleError('The GM applies this item to the target.');
        const data = message.flags[SYSTEM_ID];
        if (data.applied) throw new RuleError('Item use already applied.');
        const actor = await actorFromUuid(data.actorUuid),
          target = await actorFromUuid(data.targetUuid);
        if (!actor.testUserPermission(message.author, 'OWNER'))
          throw new RuleError('The requester does not own the item.');
        await applyItem(actor, target, actor.items.get(data.itemId));
        await message.setFlag(SYSTEM_ID, 'applied', true);
      }).catch(errorNotice)
    )
  );
}
