import {
  SYSTEM_ID,
  STATS,
  SKILLS,
  CONDITIONS,
  DAMAGE_TYPES,
  HUMANOID_LOCATIONS,
  MONSTER_LOCATIONS,
} from './config.js';
import { armorAt, stackArmor, validateLocations, RuleError } from './rules.js';
import { actorSnapshot } from './documents.js';
import { attack } from './combat.js';
import { skillRoll, save, input, prompt, escapeHTML as e, errorNotice, serial } from './runtime.js';
import { prepareActorSheetRenderOptions } from '../actor/actor-sheet-render.js';
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

export class WitcherActorSheet extends foundry.appv1.sheets.ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['witcher', 'sheet', 'actor'],
      template: `systems/${SYSTEM_ID}/templates/witcher/actor.hbs`,
      width: 1000,
      height: 850,
      tabs: [{ navSelector: '.sheet-tabs', contentSelector: '.sheet-body', initial: 'combat' }],
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
      base: actor.skillBase(key).total,
    }));
    data.inventory = actor.items
      .filter((i) => !['wound', 'ability'].includes(i.type))
      .map((item) => ({
        id: item.id,
        name: item.name,
        img: item.img,
        type: item.type,
        system: item.system,
        totalWeight: Number((item.system.weight * item.system.quantity).toFixed(2)),
        isWeapon: item.type === 'weapon' && !item.system.isAmmo,
        isDiagram: item.type === 'diagram',
        isUsable: ['alchemical', 'enhancement', 'gear', 'mount'].includes(item.type),
      }));
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
    data.effectRows = s.effects.map((x) => ({
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
      .map((i) => ({ id: i.id, name: i.name, system: i.system }));
    data.locations = s.locationTable.map((l, index) => {
      let sp;
      try {
        sp = stackArmor(armorAt(state.items, l)) + l.sp + (s.race === 'dwarf' ? 2 : 0);
      } catch {
        sp = '!';
      }
      return { ...l, index, totalSP: sp };
    });
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
      pathInput('system.ignoredEV', 'Ignored armor EV', s.ignoredEV) +
      pathInput('system.mountUuid', 'Mount / vehicle', s.mountUuid, {
        options: {
          '': 'On foot',
          ...Object.fromEntries(
            [
              ...game.actors.filter((a) => a.isOwner && a.uuid !== actor.uuid),
              ...actor.items.filter((i) => i.type === 'mount'),
            ].map((doc) => [doc.uuid, doc.name])
          ),
        },
      });
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
    return data;
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
        const value =
          el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
        if (item?.isOwner) item.update({ ['system.' + el.dataset.itemField]: value }).catch(errorNotice);
      })
    );
  }
  async _action({ witcher: action, key, itemId }) {
    const actor = this.actor,
      item = actor.items.get(itemId);
    if (action === 'skill')
      return serial(actor.uuid, () => skillRoll(actor, key, { title: SKILLS[key]?.[0] ?? key }));
    if (action === 'improve') return serial(actor.uuid, () => actor.improveSkill(key));
    if (action === 'attack') return attack(actor, item);
    if (action === 'unarmed') return attack(actor, null, { action: key });
    if (action === 'item') return item?.sheet.render(true);
    if (action === 'delete') {
      const result = await prompt('Delete item', `<p>Delete ${e(item.name)} from ${e(actor.name)}?</p>`, {
        button: 'Delete',
      });
      if (result) return item.delete();
    }
    if (action === 'newItem')
      return Item.create({ name: 'New ' + key, type: key }, { parent: actor, renderSheet: true });
    if (action === 'turn') return turnAction(actor, key, item);
    if (action === 'save') {
      const values = await prompt(
        `${key} save`,
        input('modifier', 'Modifier', { value: 0 }) +
          (key === 'death'
            ? input('luck', 'Luck spent', { value: 0, min: 0, max: actor.system.luck.value })
            : '')
      );
      if (values)
        return serial(actor.uuid, () =>
          save(actor, key, { modifier: Number(values.modifier), luck: Number(values.luck ?? 0) })
        );
    }
    if (action === 'treat') return treat(actor, item);
    if (action === 'craft') return craft(actor, item);
    if (action === 'use') return item.type === 'enhancement' ? enhance(actor, item) : useItem(actor, item);
    if (action === 'repair') return repair(actor, item);
    if (action === 'control') return controlMount(actor);
    if (action === 'fall') return fall(actor);
    if (action === 'ability') return useCreatureAbility(actor, item);
    if (action === 'loot') return rollCreatureLoot(actor);
    if (action === 'escapeWeb') return escapeWeb(actor);
    if (action === 'endEffect')
      return actor.update({ 'system.effects': actor.system.effects.filter((x) => x.id !== key) });
    if (action === 'rest') {
      const values = await prompt(
        'Rest',
        input('days', 'Days', { value: 1, min: 1 }) +
          input('strenuous', 'Strenuous activity: half healing', { type: 'checkbox' }),
        { button: 'Rest' }
      );
      if (values) return actor.rest({ days: Number(values.days), strenuous: values.strenuous });
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
    const num = (key, label = title(key)) =>
      pathInput('system.' + key, label, foundry.utils.getProperty(s, key));
    const str = (key, label = title(key), choices) =>
      pathInput('system.' + key, label, foundry.utils.getProperty(s, key), {
        type: 'text',
        ...(choices ? { options: choices } : {}),
      });
    const checkbox = (key, label = title(key)) =>
      input('system.' + key, label, { type: 'checkbox', checked: foundry.utils.getProperty(s, key) });
    data.common =
      num('quantity') +
      num('weight', 'Weight per unit (kg)') +
      num('cost', 'Price per unit (crowns)') +
      checkbox('carried') +
      checkbox('equipped') +
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
        num('reliability'),
        num('maxReliability'),
        num('hands'),
        num('range', 'Range (m)'),
        num('rangeBodyMultiplier', 'Range × BODY (0 = fixed range)'),
        num('rof', 'NPC rate of fire'),
        num('enhancements', 'Enhancement slots'),
        checkbox('loaded'),
        checkbox('jammed'),
        str('ammoId', 'Ammunition', {
          '': 'None',
          ...Object.fromEntries(
            (item.actor?.items.filter((i) => i.system.isAmmo) ?? []).map((i) => [
              i.id,
              `${i.name} (${i.system.quantity})`,
            ])
          ),
        })
      );
    if (item.type === 'shield')
      fields.push(
        num('reliability'),
        num('maxReliability'),
        num('hands'),
        num('ev'),
        str('skill', 'Defense skill', Object.fromEntries(Object.entries(SKILLS).map(([k, v]) => [k, v[0]])))
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
    if (item.type === 'wound')
      fields.push(
        str('wound.severity', 'Severity', optionsMap(['simple', 'complex', 'difficult', 'deadly'])),
        str('wound.location', 'Location'),
        str('wound.treatment', 'Treatment', optionsMap(['untreated', 'stabilized', 'treated'])),
        num('wound.daysRemaining', 'Days remaining'),
        num('wound.turnsTreated', 'Rounds of treatment'),
        checkbox('wound.permanent', 'Permanent injury')
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
    data.armorLocations =
      item.type === 'armor'
        ? (item.actor?.system.locationTable ?? HUMANOID_LOCATIONS)
            .filter((l) => s.coverage.includes(l.id))
            .map((l) => ({ id: l.id, label: l.label, value: s.sp[l.id] ?? s.stoppingPower }))
        : [];
    data.materials = item.type === 'diagram' ? s.materials : [];
    return data;
  }
  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);
    for (const key of ['coverage', 'resistances', 'damageTypes'])
      if (typeof data.system?.[key] === 'string')
        data.system[key] = data.system[key]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    return this.item.update(data);
  }
}
