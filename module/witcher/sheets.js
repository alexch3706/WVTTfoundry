import { magicLearningDisplay, magicLearningAction } from './magic-learning.js';
import { canGlide, glide } from './magic-movement.js';
import { requestMagicRecovery } from './magic-recovery.js';
import { trophyRulesFor } from './magic-trophies.js';
import { magicGearDisplay, magicGearAction } from './magic-gear.js';
import { useRitualArtifact } from './magic-ritual-effects.js';
import {
  SYSTEM_ID,
  STATS,
  SKILLS,
  CONDITIONS,
  DAMAGE_TYPES,
  HUMANOID_LOCATIONS,
  MONSTER_LOCATIONS,
} from './config.js';
import { validateLocations, strikeProfile, shieldStrike } from './rules.js';
import { armorLocationRows, actorArmorRows } from './armor-display.js';
import { woundDisplay } from './wound-display.js';
import { woundConditions } from './wounds.js';
import { woundAction, addWound, woundFingerprint } from './wound-actions.js';
import { magicActorDisplay, magicItemDisplay, castMagic, applyUIaction } from './magic-ui.js';
import { actorSnapshot, itemSnapshot } from './documents.js';
import { attack } from './combat.js';
import { skillRoll, input, prompt, escapeHTML as e, errorNotice, serial, turnIdentity } from './runtime.js';
import { setInventory, handsUsed } from './inventory.js';
import { runCommand } from './authority.js';
import { prepareActorSheetRenderOptions } from '../actor/actor-sheet-render.js';
import { renderFoundryTemplate } from '../foundry-compat.js';
import { turnAction, treat, craft, useItem, enhance, repair } from './activities.js';
import { controlMount, fall } from './transport.js';
import {
  ACTIVE_CREATURE_ABILITIES,
  useCreatureAbility,
  rollCreatureLoot,
  escapeWeb,
} from './monster-abilities.js';

const options = (values) => Object.fromEntries(values.map((v) => [v, v]));
const title = (v) => v.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
const pathInput = (path, label, value, config = {}) => input(path, label, { value, ...config });

function combatBudget(actor) {
  const combat = game.combat,
    active = !!combat?.started,
    s = actor.system,
    roundKey = active ? `${combat.id}:${combat.round}` : '',
    current = active && s.combat.key === turnIdentity(),
    currentRound = active && s.combat.roundKey === roundKey,
    actions = current ? s.combat.actions : 0,
    extra = current ? s.combat.extra : 0,
    defenses = currentRound ? s.combat.defenses : 0;
  return {
    active,
    ownTurn: active && combat.combatant?.actor?.uuid === actor.uuid,
    normalRemaining: Math.max(0, 1 - actions),
    extraRemaining: Math.max(0, 1 - extra),
    actions,
    extra,
    extraCost: s.traits.infiniteStamina ? 0 : 3,
    defenses,
    remaining: current ? s.combat.remaining : 0,
    nextDefenseCost:
      !defenses || s.conditions.includes('activelyDodging') || s.traits.infiniteStamina ? 0 : 1,
  };
}

function inventoryRow(item, actor) {
  const s = item.system,
    natural = !!s.properties.natural,
    weapon = ['weapon', 'shield'].includes(item.type) && !s.isAmmo,
    minor = !!actor && actor.type !== 'character' && !actor.system.majorNpc,
    normalOnly = minor || ['crossbow', 'bomb', 'trap', 'naturalRanged'].includes(s.category),
    isReady = natural
      ? !s.jammed && (s.maxReliability <= 0 || s.reliability > 0)
      : s.equipped && s.carried && s.quantity >= 1 && s.reliability > 0 && !s.jammed,
    styles = weapon ? (normalOnly ? ['normal'] : ['fast', 'strong']) : [],
    gripChoices = [
      { value: 0, label: `Printed (${s.hands})` },
      { value: 1, label: '1 hand' },
    ];
  if (item.type !== 'shield') gripChoices.push({ value: 2, label: '2 hands' });
  return {
    id: item.id,
    name: item.name,
    img: item.img,
    type: item.type,
    system: s,
    isArmor: item.type === 'armor',
    armorLocations: armorLocationRows(item, actor?.system.locationTable),
    totalWeight: Number((s.weight * s.quantity).toFixed(2)),
    isWeapon: weapon,
    isNatural: natural,
    reliabilityUnspecified: natural && s.maxReliability <= 0,
    showReliability: !natural || s.maxReliability > 0,
    isCrossbow: s.category === 'crossbow',
    isReady,
    attackDisabled: isReady ? '' : 'disabled',
    reloadDisabled: s.loaded ? 'disabled' : '',
    canEquip: !natural && ['weapon', 'shield', 'armor', 'gear'].includes(item.type),
    canRepair: !natural && ['weapon', 'shield', 'armor'].includes(item.type),
    showGrip: weapon && !natural && s.equipped,
    grip: handsUsed(item),
    gripChoices: gripChoices.map((choice) => ({
      ...choice,
      selectedAttribute: Number(s.handsUsed) === choice.value ? 'selected' : '',
    })),
    damageLabel:
      item.type === 'shield' && actor
        ? shieldStrike(itemSnapshot(item), actor.system.derived.stats.body).damage
        : s.damage,
    attackBase: actor && weapon ? actor.skillBase(s.skill, { stat: s.stat }).total + s.accuracy : null,
    attackStyles: styles.map((style) => {
      const profile = strikeProfile(itemSnapshot(item), {
        style,
        npc: minor,
        underwater: actor?.system.environment.underwater,
      });
      return {
        itemId: item.id,
        disabledAttribute: isReady ? '' : 'disabled',
        style,
        label:
          style === 'normal'
            ? minor
              ? `Attack · ROF ${profile.attacks}`
              : 'Attack'
            : `${title(style)} · ${profile.attacks} strike${profile.attacks > 1 ? 's' : ''}`,
        hint:
          style === 'strong'
            ? '−3 attack; double damage'
            : style === 'fast'
              ? 'Normal damage per strike'
              : 'Normal attack',
      };
    }),
    isDiagram: item.type === 'diagram',
    isUsable:
      ['alchemical', 'enhancement', 'gear'].includes(item.type) ||
      (item.type === 'component' && s.ability.key === 'crushEssence'),
    useLabel:
      s.ability.key === 'crushEssence'
        ? 'Process'
        : s.category === 'mutagen'
          ? 'Prepare mutagen'
          : item.type === 'enhancement'
            ? 'Apply'
            : 'Use',
  };
}

async function changeInventory(actor, item, patch) {
  const drawing =
      ['weapon', 'shield'].includes(item.type) &&
      !item.system.properties.natural &&
      patch.equipped &&
      !item.system.equipped,
    budget = combatBudget(actor);
  let action = {};
  if (drawing && budget.active && (budget.actions > 0 || budget.remaining > 0)) {
    action = await prompt(
      `Draw ${item.name}`,
      '<p>Drawing a weapon uses an action.</p>' +
        input('extra', `Use the extra action (${actor.system.traits.infiniteStamina ? 0 : 3} STA)`, {
          type: 'checkbox',
          checked: budget.actions > 0,
        }) +
        (budget.remaining > 0
          ? input('forfeit', `Forfeit ${budget.remaining} remaining strike(s)`, { type: 'checkbox' })
          : ''),
      { button: 'Draw weapon' }
    );
    if (!action) return;
  }
  return setInventory(actor, item, patch, action);
}

export class WitcherActorSheet extends foundry.appv1.sheets.ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['witcher', 'sheet', 'actor'],
      template: `systems/${SYSTEM_ID}/templates/witcher/actor.hbs`,
      width: 1000,
      height: 850,
      tabs: [{ navSelector: '.sheet-tabs', contentSelector: '.sheet-body', initial: 'combat' }],
      dragDrop: [{ dragSelector: '.inventory-table .item', dropSelector: null }],
    });
  }
  async _render(force = false, options = {}) {
    return super._render(force, prepareActorSheetRenderOptions(this, force, options));
  }
  async getData(options) {
    const data = await super.getData(options);
    const actor = this.actor,
      s = actor.system,
      state = actorSnapshot(actor);
    data.system = s;
    data.isMonster = actor.type === 'monster';
    data.isNpc = actor.type !== 'character';
    data.combatBudget = combatBudget(actor);
    data.canGlide = canGlide(s);
    data.trophyReputation = trophyRulesFor(actorSnapshot(actor)).reputation;
    data.skillMaximum = actor.type === 'character' ? 10 : 100;
    data.statRows = STATS.map((key) => ({
      key,
      label: key.toUpperCase(),
      value: s.stats[key],
      current: s.derived.stats[key],
    }));
    data.skillRows = Object.entries(SKILLS).map(([key, [name, stat, difficult]]) => ({
      key,
      name,
      stat: stat.toUpperCase(),
      difficult: difficult === 2,
      rank: s.skills[key],
      maximum: data.skillMaximum,
      base: actor.skillBase(key).total,
    }));
    data.inventory = actor.items
      .filter((i) => !['wound', 'ability', 'magic'].includes(i.type))
      .map((item) => inventoryRow(item, actor));
    data.weapons = data.inventory.filter((item) => item.isWeapon);
    data.creatureAbilities = actor.items
      .filter((i) => i.type === 'ability')
      .map((i) => ({
        id: i.id,
        name: i.name,
        text: i.system.effectText,
        page: i.system.page,
        usable: ACTIVE_CREATURE_ABILITIES.has(i.system.ability.key),
        mode:
          i.system.ability.mode === 'reference'
            ? 'Reference'
            : i.system.ability.mode === 'defense'
              ? 'Available in defense choices'
              : '',
      }));
    data.hasBestiary = !!s.source || data.creatureAbilities.length > 0;
    data.inWeb = s.effects.some((x) => x.key === 'Webbing');
    data.effectRows = s.effects
      .filter((effect) => !effect.magic)
      .map((x) => ({
        id: x.id,
        name: x.key,
        expires: x.expires
          ? Math.max(0, Math.ceil((x.expires - game.time.worldTime) / 3)) + ' rounds'
          : x.untilTurn
            ? 'Until next turn'
            : '',
      }));
    data.wounds = actor.items
      .filter((i) => i.type === 'wound')
      .map((item) => woundDisplay(item, { actor, isGM: game.user.isGM }));
    data.magic = magicActorDisplay(actor);
    data.magicLearning = magicLearningDisplay(actor);
    data.magicPanel = await renderFoundryTemplate(`systems/${SYSTEM_ID}/templates/witcher/magic.hbs`, {
      magic: data.magic,
      magicLearning: data.magicLearning,
      canGlide: canGlide(actor.system),
    });
    data.woundConditions = woundConditions([...actor.items])
      .map((key) => CONDITIONS[key])
      .join(', ');
    data.locations = actorArmorRows(state, s.locationTable);
    data.conditionRows = Object.entries(CONDITIONS).map(([key, label]) => ({
      key,
      label,
      active: s.conditions.includes(key),
      cssClass: s.conditions.includes(key) ? 'active' : '',
    }));
    data.identity =
      pathInput('system.race', 'Race', s.race, {
        options: optionsMap(['human', 'elf', 'dwarf', 'witcher', 'other']),
      }) +
      pathInput('system.profession', 'Profession', s.profession, { type: 'text' }) +
      pathInput('system.age', 'Age', s.age) +
      pathInput('system.gender', 'Gender', s.gender, { type: 'text' }) +
      pathInput('system.homeland', 'Homeland', s.homeland, { type: 'text' });
    data.setup =
      pathInput('system.anatomy', 'Anatomy', s.anatomy, {
        options: optionsMap(['humanoid', 'monster', 'custom']),
      }) +
      pathInput('system.size', 'Size', s.size, {
        options: optionsMap(['small', 'medium', 'large', 'huge']),
      }) +
      input('system.majorNpc', 'Major NPC: fast / strong strikes', {
        type: 'checkbox',
        checked: s.majorNpc,
      }) +
      input('system.organless', 'Elementa / specter: no vital organs', {
        type: 'checkbox',
        checked: s.organless,
      }) +
      input('system.silverVulnerable', 'Half damage from non-silver weapons', {
        type: 'checkbox',
        checked: s.silverVulnerable,
      }) +
      input('system.meteoriteVulnerable', 'Meteorite also bypasses this resistance', {
        type: 'checkbox',
        checked: s.meteoriteVulnerable,
      }) +
      pathInput('system.ignoredEV', 'Ignored armor EV', s.ignoredEV);
    if (actor.type === 'monster')
      data.setup += pathInput('system.category', 'Monster category', s.category, {
        options: optionsMap([
          'beast',
          'cursed',
          'draconid',
          'elementa',
          'hybrid',
          'insectoid',
          'necrophage',
          'ogroid',
          'relict',
          'specter',
          'vampire',
          'monster',
        ]),
      });
    data.overrides = Object.entries(s.overrides)
      .map(([key, value]) =>
        pathInput('system.overrides.' + key, `${key.toUpperCase()} override (0 = automatic)`, value)
      )
      .join('');
    data.environment =
      pathInput('system.environment.light', 'Lighting', s.environment.light, {
        options: {
          daylight: 'Daylight',
          dim: 'Dim light',
          dark: 'Darkness',
          moonlight: 'Moonlight',
          bright: 'Facing bright sunlight',
        },
      }) +
      ['underwater', 'swamp', 'ice', 'heat']
        .map((key) =>
          input('system.environment.' + key, title(key), { type: 'checkbox', checked: s.environment[key] })
        )
        .join('');
    data.damageTraits = ['resistances', 'naturalResistances', 'immunities', 'vulnerabilities']
      .map((key) =>
        pathInput('trait.' + key, title(key) + ' (comma-separated)', s[key].join(', '), { type: 'text' })
      )
      .join('');
    data.environment += pathInput(
      'system.environment.suffocationCause',
      'Cause of environmental suffocation',
      s.environment.suffocationCause ?? 'unspecified',
      {
        options: {
          unspecified: 'Unspecified / physical choking',
          drowning: 'Drowning',
          airless: 'Lack of breathable air',
          smoke: 'Smoke',
          airbornePoison: 'Airborne poison',
          taintedAir: 'Tainted air',
        },
      }
    );
    return data;
  }
  async _onDropItemCreate(itemData, event) {
    if (!this.actor.isOwner) return [];
    const entries = Array.isArray(itemData) ? itemData : [itemData];
    if (!entries.some((item) => item.type === 'wound')) return super._onDropItemCreate(itemData, event);
    const created = [];
    for (const item of entries) {
      const result =
        item.type === 'wound' ? await addWound(this.actor, item) : await super._onDropItemCreate(item, event);
      if (result) created.push(...(Array.isArray(result) ? result : [result]));
    }
    return created;
  }
  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0] ?? html;
    root.querySelectorAll('[data-witcher]').forEach((button) =>
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (!this.actor.isOwner) return;
        button.disabled = true;
        this._action(button.dataset)
          .catch(errorNotice)
          .finally(() => {
            button.disabled = false;
          });
      })
    );
    root.querySelectorAll('[data-item-field]').forEach((el) =>
      el.addEventListener('change', (event) => {
        event.stopPropagation();
        const item = this.actor.items.get(el.dataset.itemId);
        const value = el.type === 'checkbox' ? el.checked : Number(el.value);
        if (!item?.isOwner) return;
        el.disabled = true;
        changeInventory(this.actor, item, { [el.dataset.itemField]: value })
          .catch(errorNotice)
          .finally(() => this.render(false));
      })
    );
  }
  async _action({ witcher: action, key, itemId, effectId, style }) {
    const actor = this.actor,
      item = actor.items.get(itemId);
    if (action === 'skill')
      return serial(actor.uuid, () => skillRoll(actor, key, { title: SKILLS[key]?.[0] ?? key }));
    if (action === 'improve') return serial(actor.uuid, () => actor.improveSkill(key));
    if (action === 'attack') return attack(actor, item, { style });
    if (action === 'equip') return changeInventory(actor, item, { equipped: !item.system.equipped });
    if (action === 'unarmed') return attack(actor, null, { action: key });
    if (action === 'item') return item?.sheet.render(true);
    if (action === 'wound') return woundAction(actor, item, key);
    if (action === 'magicLearning') return magicLearningAction(actor, key, effectId);
    if (action === 'magicCast') return castMagic(actor, item);
    if (action === 'magicEffect') {
      const effect = actor.system.effects.find((entry) => entry.id === effectId);
      if (!effect) throw new Error('This magical effect no longer exists.');
      return applyUIaction(actor, effect, key);
    }
    if (action === 'delete') {
      const result = await prompt('Delete item', `<p>Delete ${e(item.name)} from ${e(actor.name)}?</p>`, {
        button: 'Delete',
      });
      if (result) {
        if (item.type === 'wound')
          return runCommand('removeWound', {
            actorUuid: actor.uuid,
            itemId: item.id,
            expected: woundFingerprint(item),
          });
        return item.delete();
      }
    }
    if (action === 'newItem')
      return Item.create({ name: 'New ' + key, type: key }, { parent: actor, renderSheet: true });
    if (action === 'turn') return turnAction(actor, key, item);
    if (action === 'save') {
      if (key !== 'death') return runCommand('combatSave', { actorUuid: actor.uuid, kind: key, luck: 0 });
      const values = await prompt(
        'Death save',
        input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value })
      );
      if (values)
        return runCommand('combatSave', { actorUuid: actor.uuid, kind: key, luck: Number(values.luck) });
    }
    if (action === 'treat') return treat(actor, item);
    if (action === 'craft') return craft(actor, item);
    if (action === 'use') return item.type === 'enhancement' ? enhance(actor, item) : useItem(actor, item);
    if (action === 'repair') return repair(actor, item);
    if (action === 'control') return controlMount(actor);
    if (action === 'fall') return fall(actor);
    if (action === 'glide') return glide(actor);
    if (action === 'magicRecovery') return requestMagicRecovery(actor, effectId);
    if (action === 'ability') return useCreatureAbility(actor, item);
    if (action === 'loot') return rollCreatureLoot(actor);
    if (action === 'escapeWeb') return escapeWeb(actor);
    if (action === 'endEffect')
      return actor.update({ 'system.effects': actor.system.effects.filter((x) => x.id !== key) });
    if (action === 'rest') {
      const restHexes = actor.system.effects.filter(
        (effect) => effect.magic?.kind === 'hex' && !effect.magic.suppressed && !effect.disabled
      );
      const need = restHexes.some((effect) => effect.magic.key === 'unending-need');
      const nightmares = restHexes.filter((effect) => effect.magic.key === 'the-nightmare');
      const values = await prompt(
        'Rest',
        input('days', 'Days', { value: 1, min: 1 }) +
          input('strenuous', 'Strenuous activity: half healing', { type: 'checkbox' }) +
          (need
            ? input('sleepHours', 'Uninterrupted sleep hours (Unending Need requires 10)', {
                value: 8,
                min: 0,
              }) + input('meals', 'Meals eaten (Unending Need requires 5)', { value: 3, min: 0 })
            : '') +
          nightmares
            .map((effect) =>
              input(
                `nightmare_${effect.id}`,
                `Nightmare DC ${effect.magic.castingTotal}: manual d10, optional`,
                { type: 'text' }
              )
            )
            .join(''),
        { button: 'Rest' }
      );
      if (values)
        return runCommand(
          'woundRest',
          {
            actorUuid: actor.uuid,
            days: Number(values.days),
            strenuous: !!values.strenuous,
            sleepHours: Number(values.sleepHours ?? 8),
            meals: Number(values.meals ?? 3),
            nightmareDice: Object.fromEntries(
              nightmares.map((effect) => [effect.id, values[`nightmare_${effect.id}`]])
            ),
          },
          { label: `${actor.name}: rest` }
        );
    }
    if (action === 'refreshLuck') return actor.update({ 'system.luck.value': actor.system.luck.max });
    if (action === 'resetAnatomy')
      return actor.update({
        'system.locations': structuredClone(
          actor.system.anatomy === 'monster' ? MONSTER_LOCATIONS : HUMANOID_LOCATIONS
        ),
      });
    if (action === 'addLocation') {
      const table = foundry.utils.deepClone(actor.system.locations);
      table.push({
        id: 'newLocation',
        label: 'New location',
        group: 'arm',
        min: 10,
        max: 10,
        aim: -3,
        multiplier: 0.5,
        sp: 0,
        maxSp: 0,
      });
      // Open the complete table for editing; saving validates the final 1–10 ranges.
      return this.editAnatomy(table);
    }
    if (action === 'editAnatomy') return this.editAnatomy(actor.system.locations);
    if (action === 'customSkill') {
      const values = await prompt(
        'Add custom / profession skill',
        input('name', 'Name', { type: 'text' }) +
          input('stat', 'Statistic', { value: 'int', options: optionsMap(STATS) }) +
          input('rank', 'Rank', { value: 0, min: 0, max: 10 }) +
          input('difficult', 'Double improvement cost', { type: 'checkbox' }),
        { button: 'Add' }
      );
      if (values)
        return actor.update({
          'system.customSkills': [
            ...actor.system.customSkills,
            { ...values, id: foundry.utils.randomID(), rank: Number(values.rank) },
          ],
        });
    }
  }
  async editAnatomy(table) {
    const content =
      `<p>Ranges must cover d10 results 1–10 exactly once. Critical group determines the wound table used for aimed hits.</p>` +
      table
        .map(
          (l, i) =>
            `<fieldset><legend>${e(l.label)}</legend>${pathInput(`${i}.id`, 'Identifier', l.id, { type: 'text' })}${pathInput(`${i}.label`, 'Label', l.label, { type: 'text' })}${pathInput(`${i}.group`, 'Critical group', l.group || (/head/i.test(l.id) ? 'head' : /torso/i.test(l.id) ? 'torso' : /leg/i.test(l.id) ? 'leg' : 'arm'), { options: optionsMap(['head', 'torso', 'arm', 'leg']) })}${['min', 'max', 'aim', 'multiplier', 'sp', 'maxSp'].map((k) => pathInput(`${i}.${k}`, title(k), l[k], { step: k === 'multiplier' ? 0.5 : 1 })).join('')}${input(`${i}.delete`, 'Remove location', { type: 'checkbox' })}</fieldset>`
        )
        .join('');
    const values = await prompt('Hit locations', content, { button: 'Save anatomy', width: 560 });
    if (!values) return;
    const updated = [];
    for (const [index, location] of table.entries()) {
      if (values[`${index}.delete`]) continue;
      const row = { ...location };
      for (const key of ['id', 'label', 'group']) row[key] = values[`${index}.${key}`];
      for (const key of ['min', 'max', 'aim', 'multiplier', 'sp', 'maxSp'])
        row[key] = Number(values[`${index}.${key}`]);
      updated.push(row);
    }
    validateLocations(updated);
    await this.actor.update({ 'system.anatomy': 'custom', 'system.locations': updated });
  }
  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);
    if (data.condition) {
      data.system ??= {};
      data.system.conditions = Object.keys(data.condition).filter(
        (k) => data.condition[k] === true || data.condition[k] === 'on'
      );
      delete data.condition;
    }
    if (data.trait) {
      data.system ??= {};
      for (const [key, value] of Object.entries(data.trait))
        data.system[key] = String(value)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      delete data.trait;
    }
    // A selected anatomy has its own complete table; custom changes use the validated editor.
    if (
      data.system?.anatomy &&
      data.system.anatomy !== this.actor.system.anatomy &&
      data.system.anatomy !== 'custom'
    )
      data.system.locations = structuredClone(
        data.system.anatomy === 'monster' ? MONSTER_LOCATIONS : HUMANOID_LOCATIONS
      );
    return this.actor.update(data);
  }
}
const optionsMap = (values) => Object.fromEntries(values.map((v) => [v, title(v)]));

export class WitcherItemSheet extends foundry.appv1.sheets.ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['witcher', 'sheet', 'item'],
      template: `systems/${SYSTEM_ID}/templates/witcher/item.hbs`,
      width: 650,
      height: 780,
    });
  }
  async getData(options) {
    const data = await super.getData(options);
    const item = this.item,
      s = item.system;
    data.system = s;
    data.owned = !!item.actor;
    data.ownerName = item.actor?.name ?? '';
    data.isWound = item.type === 'wound';
    data.isMagic = item.type === 'magic';
    if (data.isMagic) {
      data.magic = magicItemDisplay(item);
      data.magicCard = await renderFoundryTemplate(`systems/${SYSTEM_ID}/templates/witcher/magic-item.hbs`, {
        magic: data.magic,
        system: s,
      });
      return data;
    }
    if (data.isWound) {
      data.wound = woundDisplay(item, { isGM: game.user.isGM });
      return data;
    }
    data.inventoryItem = inventoryRow(item, item.actor);
    data.magicGear = magicGearDisplay(item);
    data.ritualUse = ['magical-message', 'magical-guestbook', 'spell-jar'].includes(
      item.flags?.[SYSTEM_ID]?.ritualArtifact?.key
    );
    const num = (key, label = title(key)) =>
      pathInput('system.' + key, label, foundry.utils.getProperty(s, key));
    const str = (key, label = title(key), choices) =>
      pathInput('system.' + key, label, foundry.utils.getProperty(s, key), {
        type: 'text',
        ...(choices ? { options: choices } : {}),
      });
    const checkbox = (key, label = title(key)) =>
      input('system.' + key, label, { type: 'checkbox', checked: foundry.utils.getProperty(s, key) });
    data.common = s.properties.natural
      ? str('category')
      : num('quantity') +
        num('weight', 'Weight per unit (kg)') +
        num('cost', 'Price per unit (crowns)') +
        checkbox('carried') +
        (data.inventoryItem.canEquip ? checkbox('equipped') : '') +
        str('category') +
        str('availability') +
        str('concealment');
    const fields = [];
    if (item.type === 'weapon')
      fields.push(
        str('skill', 'Attack skill', Object.fromEntries(Object.entries(SKILLS).map(([k, v]) => [k, v[0]]))),
        str('stat', 'Attack stat', optionsMap(STATS)),
        str('damage', 'Damage formula'),
        str('damageTypes', 'Damage types (comma-separated)'),
        num('accuracy'),
        num('range', 'Range (m)'),
        num('rangeBodyMultiplier', 'Range × BODY (0 = fixed range)'),
        num('rof', 'NPC rate of fire'),
        ...(!s.properties.natural
          ? [
              num('reliability'),
              num('maxReliability'),
              num('hands'),
              num('enhancements', 'Enhancement slots'),
            ]
          : []),
        ...(s.category === 'crossbow' ? [checkbox('loaded')] : []),
        ...(!s.properties.natural ? [checkbox('jammed')] : []),
        ...(['bow', 'crossbow'].includes(s.category)
          ? [
              str('ammoId', 'Ammunition', {
                '': 'None',
                ...Object.fromEntries(
                  (item.actor?.items.filter((i) => i.system.isAmmo) ?? []).map((i) => [
                    i.id,
                    `${i.name} (${i.system.quantity})`,
                  ])
                ),
              }),
            ]
          : [])
      );
    if (item.type === 'shield')
      fields.push(
        num('reliability'),
        num('maxReliability'),
        num('hands'),
        num('ev'),
        str('armorClass', 'Shield size', optionsMap(['light', 'medium', 'heavy'])),
        num('enhancements', 'Enhancement slots'),
        str('skill', 'Defense skill', Object.fromEntries(Object.entries(SKILLS).map(([k, v]) => [k, v[0]])))
      );
    if (item.type === 'weapon' && s.properties.natural)
      fields.push(
        num('reliability', 'Current REL'),
        num('maxReliability', 'Maximum REL (0 = not specified)'),
        checkbox('jammed')
      );
    if (['weapon', 'shield'].includes(item.type) && !s.properties.natural)
      fields.push(
        str('handsUsed', 'Grip', {
          0: 'Printed grip',
          1: 'One hand',
          ...(item.type === 'weapon' ? { 2: 'Two hands' } : {}),
        }),
        str('school', 'Witcher school'),
        checkbox('witcherWeapon', 'Witcher weapon')
      );
    if (item.type === 'armor' || item.type === 'enhancement')
      fields.push(
        str('armorClass', 'Armor class', optionsMap(['light', 'medium', 'heavy'])),
        num('stoppingPower', 'Maximum stopping power'),
        str('coverage', 'Coverage identifiers (comma-separated)'),
        str('resistances', 'Resistances (comma-separated)'),
        num('ev'),
        num('enhancements')
      );
    if (['weapon', 'shield', 'armor', 'enhancement', 'gear'].includes(item.type)) {
      data.properties = Object.entries(s.properties)
        .map(([key, value]) =>
          typeof value === 'boolean'
            ? checkbox('properties.' + key, title(key))
            : typeof value === 'number'
              ? num('properties.' + key, title(key))
              : str('properties.' + key, title(key))
        )
        .join('');
    }
    if (item.type === 'gear') fields.push(checkbox('isAmmo'), str('ammoCategory'));
    if (item.type === 'component')
      fields.push(
        str('substance'),
        num('substanceUnits'),
        num('forageDC'),
        str('forageLocation'),
        str('forageQuantity')
      );
    if (item.type === 'alchemical')
      fields.push(
        num('toxicity', 'Toxicity (%)'),
        num('duration', 'Duration (rounds)'),
        checkbox('consumable')
      );
    if (s.category === 'mutagen') fields.push(num('craftDC', 'Preparation Alchemy DC'));
    if (item.type === 'diagram')
      fields.push(
        str('skill', 'Crafting skill', { crafting: 'Crafting', alchemy: 'Alchemy' }),
        num('craftDC'),
        str('craftTime'),
        str('craftLevel'),
        str('productName'),
        str('productUuid'),
        num('productQuantity'),
        num('investment')
      );
    if (item.type === 'mount')
      for (const key of Object.keys(s.mount))
        fields.push(
          typeof s.mount[key] === 'string' ? str('mount.' + key, title(key)) : num('mount.' + key, title(key))
        );
    if (item.type === 'ability')
      fields.push(
        str('ability.key', 'Ability identifier'),
        str('ability.mode', 'Rule category'),
        str('effectText', 'Rule text')
      );
    data.details = fields.join('');
    data.system = s;
    data.description = s.description;
    data.isArmor = item.type === 'armor';
    data.armorLocations = data.inventoryItem.armorLocations;
    data.materials = s.materials;
    data.bonuses = Object.entries(s.bonuses).map(([key, value]) => ({
      label:
        { hp: 'Health', sta: 'Stamina', meleeBonus: 'Melee damage', vigor: 'Vigor' }[key] ??
        (STATS.includes(key) ? key.toUpperCase() : title(key)),
      value: value > 0 ? `+${value}` : String(value),
    }));
    return data;
  }
  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0] ?? html;
    root.querySelectorAll('[data-witcher]').forEach((button) =>
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        const item = this.item,
          actor = item.actor;
        if (!actor?.isOwner) return;
        button.disabled = true;
        try {
          switch (button.dataset.witcher) {
            case 'magicGear':
              await magicGearAction(actor, item, button.dataset.key, button.dataset.magicKey);
              break;
            case 'ritualUse':
              await useRitualArtifact(actor, item);
              break;
            case 'magicCast':
              await castMagic(actor, item);
              break;
            case 'wound':
              await woundAction(actor, item, button.dataset.key);
              break;
            case 'equip':
              await changeInventory(actor, item, { equipped: !item.system.equipped });
              break;
            case 'attack':
              await attack(actor, item, { style: button.dataset.style });
              break;
            case 'use':
              await (item.type === 'enhancement' ? enhance(actor, item) : useItem(actor, item));
              break;
            case 'craft':
              await craft(actor, item);
              break;
            case 'repair':
              await repair(actor, item);
              break;
          }
        } catch (error) {
          errorNotice(error);
        } finally {
          this.render(false);
        }
      })
    );
  }
  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);
    if (this.item.type === 'magic') {
      const patch = {};
      if (Object.hasOwn(data, 'name')) patch.name = data.name;
      if (Object.hasOwn(data, 'img')) patch.img = data.img;
      if (Object.hasOwn(data.system ?? {}, 'notes')) patch['system.notes'] = data.system.notes;
      return this.item.update(patch);
    }
    // Wound state and timers change through validated actions, never a generic form submission.
    if (this.item.type === 'wound') {
      const patch = {};
      if (Object.hasOwn(data, 'name')) patch.name = data.name;
      if (Object.hasOwn(data, 'img')) patch.img = data.img;
      if (this.item.actor && Object.hasOwn(data.system?.wound ?? {}, 'notes'))
        patch['system.wound.notes'] = data.system.wound.notes;
      return this.item.update(patch);
    }
    for (const key of ['coverage', 'resistances', 'damageTypes'])
      if (typeof data.system?.[key] === 'string')
        data.system[key] = data.system[key]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    if (this.item.actor && data.system) {
      const patch = {};
      for (const key of ['quantity', 'carried', 'equipped', 'handsUsed']) {
        if (!Object.hasOwn(data.system, key)) continue;
        const value = ['quantity', 'handsUsed'].includes(key) ? Number(data.system[key]) : data.system[key];
        if (value !== this.item.system[key]) patch[key] = value;
        delete data.system[key];
      }
      if (Object.keys(patch).length) {
        try {
          await changeInventory(this.item.actor, this.item, patch);
        } catch (error) {
          errorNotice(error);
          this.render(false);
          return;
        }
        this.render(false);
      }
    }
    return this.item.update(data);
  }
}
