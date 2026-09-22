import { activeHexes, hexSkillModifier, hexRestPlan, hexCriticalWound } from './magic-hex-rules.js';
import { woundItemData } from './wound-catalog.js';
import { magicModifierSummary, magicSkillRules, magicRecoveryRules } from './magic-effect-hooks.js';
import { STATS, SKILLS, HUMANOID_LOCATIONS, MONSTER_LOCATIONS, CONDITIONS, SYSTEM_ID } from './config.js';
import {
  derivedStats,
  hitLocations,
  validateLocations,
  RuleError,
  skillImprovementCost,
  beats,
} from './rules.js';
import { immuneTo } from './monster-rules.js';
import { activeAlchemy, lastHopeLocked } from './alchemy-rules.js';
import { woundModifiers, WOUNDS } from './wounds.js';
import { advanceWoundDays, woundCheckModifier, recoveryClockChanged } from './wound-rules.js';
import { commitActor, check, checkHTML, chat } from './runtime.js';

const f = foundry.data.fields;
const num = (initial = 0, options = {}) =>
  new f.NumberField({ initial, required: true, nullable: false, ...options });
const str = (initial = '') => new f.StringField({ initial, required: true, nullable: false });
const bool = (initial = false) => new f.BooleanField({ initial });
const strings = () => new f.ArrayField(str());
const resource = (initial = 25) => new f.SchemaField({ value: num(initial), max: num(initial, { min: 0 }) });
const numericObject = (keys, value = 0) =>
  new f.SchemaField(Object.fromEntries(keys.map((k) => [k, num(value)])));
const locationField = () =>
  new f.SchemaField({
    id: str(),
    label: str(),
    group: str(),
    min: num(1, { integer: true, min: 1, max: 10 }),
    max: num(1, { integer: true, min: 1, max: 10 }),
    aim: num(),
    multiplier: num(1, { min: 0 }),
    sp: num(0, { min: 0 }),
    maxSp: num(0, { min: 0 }),
    weakName: str(),
    weakSp: num(0, { min: 0 }),
    weakMaxSp: num(0, { min: 0 }),
  });

export class WitcherActorData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      manualCombat: bool(),
      stats: numericObject(STATS, 5),
      statModifiers: numericObject(STATS),
      skills: numericObject(Object.keys(SKILLS)),
      hp: resource(),
      sta: resource(),
      luck: resource(5),
      toxicity: resource(0),
      coins: num(0, { min: 0 }),
      ip: num(0, { min: 0 }),
      race: str('human'),
      profession: str(),
      age: num(20),
      gender: str(),
      homeland: str(),
      biography: new f.HTMLField({ initial: '' }),
      source: str(),
      page: num(),
      category: str('humanoid'),
      social: new f.SchemaField({
        relationships: new f.ArrayField(new f.ObjectField()),
        reputationEffects: new f.ArrayField(new f.ObjectField()),
      }),
      vigor: num(),
      magic: new f.SchemaField({
        tradition: str(),
        roundKey: str(),
        spent: num(0, { min: 0 }),
        exhaustedRecovery: num(0, { min: 0 }),
        dimeritiumUnits: num(0, { min: 0 }),
        dimeritiumContact: bool(),
        speech: bool(true),
        gestures: bool(true),
        minorGestures: bool(true),
        coneAngle: num(90, { min: 1, max: 360 }),
        lastTurn: str(),
        learning: new f.ArrayField(new f.ObjectField()),
        magicIP: num(0, { min: 0 }),
        powerUses: new f.ArrayField(new f.ObjectField()),
        powerFocus: new f.ObjectField({ initial: {} }),
        leyConnection: new f.ObjectField({ initial: {} }),
        birthEligible: new f.BooleanField({ initial: null, nullable: true }),
      }),
      bestiary: new f.ObjectField({ initial: {} }),
      traits: new f.SchemaField({
        feralInt: num(),
        regeneration: num(),
        sunlightRegeneration: num(),
        furyThreshold: num(),
        furyRegeneration: num(),
        nightVision: bool(),
        amphibious: bool(),
        infiniteStamina: bool(),
        mindless: bool(),
        unreasoning: bool(),
        crushingForce: bool(),
        alwaysIncorporeal: bool(),
        pounce: bool(),
        scentTracking: bool(),
        moonlightPenalty: num(),
        sensitiveHearing: bool(),
        landStats: num(),
        moondustStopsRegeneration: bool(),
        flightDamageThreshold: num(),
        flightSpeed: num(),
      }),
      anatomy: str('humanoid'),
      locations: new f.ArrayField(locationField()),
      conditions: strings(),
      resistances: strings(),
      naturalResistances: strings(),
      immunities: strings(),
      vulnerabilities: strings(),
      silverVulnerable: bool(),
      meteoriteVulnerable: bool(),
      majorNpc: bool(),
      size: str('medium'),
      ignoredEV: num(),
      deathSaves: num(0, { integer: true, min: 0 }),
      pendingDeathSaves: num(0, { integer: true, min: 0 }),
      unconsciousRecovery: num(),
      healingEnabled: bool(),
      healingBonus: num(),
      overrides: numericObject(['hp', 'sta', 'enc', 'rec', 'stun', 'meleeBonus', 'run', 'leap']),
      combat: new f.SchemaField({
        key: str(),
        roundKey: str(),
        actions: num(),
        extra: num(),
        defenses: num(),
        remaining: num(),
        full: bool(),
        strikeIndex: num(),
        attackAction: str(),
        npcWeaponId: str(),
        npcStrikes: num(),
        reactions: new f.ArrayField(new f.ObjectField()),
        weaponId: str(),
        style: str(),
        extraPenalty: num(),
        aim: num(),
        grappledBy: str(),
        grappling: str(),
        applied: strings(),
        lastEffectTurn: str(),
        hitThisRound: bool(),
      }),
      environment: new f.SchemaField({
        light: str('daylight'),
        underwater: bool(),
        swamp: bool(),
        ice: bool(),
        heat: bool(),
        suffocationCause: str('unspecified'),
      }),
      notes: str(),
      reputation: num(),
      organless: bool(),
      mountUuid: str(),
      mountDistance: num(),
      transport: new f.SchemaField({
        control: num(),
        ramDamage: str(),
        feral: bool(),
        vehicle: bool(),
        water: bool(),
        reinsDropped: bool(),
        spooked: bool(),
        trapped: bool(),
      }),
      effects: new f.ArrayField(new f.ObjectField()),
      professionRanks: new f.TypedObjectField(num()),
      customSkills: new f.ArrayField(
        new f.SchemaField({ id: str(), name: str(), stat: str('int'), rank: num(), difficult: bool() })
      ),
    };
  }
}
export class WitcherMonsterData extends WitcherActorData {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      anatomy: str('monster'),
      silverVulnerable: bool(true),
      category: str('monster'),
      notes: str(),
    };
  }
}
export class WitcherItemData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      magic: new f.ObjectField({ initial: {} }),
      description: new f.HTMLField({ initial: '' }),
      source: str(),
      page: num(),
      quantity: num(1, { min: 0 }),
      weight: num(0, { min: 0 }),
      cost: num(0, { min: 0 }),
      carried: bool(true),
      equipped: bool(),
      focusUse: str(),
      category: str(),
      availability: str(),
      concealment: str(),
      notes: str(),
      effectText: str(),
      priceText: str(),
      relic: bool(),
      school: str(),
      witcherWeapon: bool(),
      bonuses: new f.TypedObjectField(num()),
      forageDC: num(),
      forageLocation: str(),
      forageQuantity: str(),
      attachments: new f.ArrayField(new f.ObjectField()),
      oil: new f.SchemaField({ name: str(), expires: num() }),
      memorized: bool(),
      mount: new f.SchemaField({
        athletics: num(),
        control: num(),
        speed: num(),
        speedModifier: num(),
        hp: num(),
        maxHp: num(),
        ramDamage: str(),
        actorUuid: str(),
      }),
      skill: str('melee'),
      stat: str('ref'),
      rank: num(0, { min: 0 }),
      difficult: bool(),
      damage: str('1d6'),
      damageTypes: strings(),
      accuracy: num(),
      reliability: num(10, { min: 0 }),
      maxReliability: num(10, { min: 0 }),
      hands: num(1, { integer: true, min: 0, max: 2 }),
      handsUsed: num(0, { integer: true, min: 0, max: 2 }),
      range: num(),
      rangeBodyMultiplier: num(),
      rof: num(1, { integer: true, min: 1 }),
      loaded: bool(true),
      jammed: bool(),
      ammoId: str(),
      isAmmo: bool(),
      ammoCategory: str(),
      enhancements: num(0, { min: 0 }),
      properties: new f.SchemaField({
        armorPiercing: bool(),
        improvedArmorPiercing: bool(),
        ablating: bool(),
        bleeding: num(),
        poison: num(),
        fire: num(),
        stun: num(),
        balanced: bool(),
        silver: bool(),
        meteorite: bool(),
        silverDamage: str(),
        nonlethal: bool(),
        longReach: bool(),
        grappling: bool(),
        brawling: bool(),
        slowReload: bool(),
        concealment: bool(),
        focus: num(),
        greaterFocus: bool(),
        burrower: bool(),
        area: num(),
        allLocations: bool(),
        parrying: bool(),
        restrictedVision: bool(),
        fullCover: bool(),
        selfStanding: bool(),
        freeze: num(),
        stagger: num(),
        stunWeapon: bool(),
        balancedBonus: num(),
        natural: bool(),
        fixedDamage: bool(),
        cannotParry: bool(),
        wearMultiplier: num(1),
        severableTongue: bool(),
        fullRound: bool(),
        knockback: num(),
        minimumDistance: num(),
        webbing: bool(),
        blindRounds: str(),
      }),
      armorClass: str('light'),
      coverage: strings(),
      stoppingPower: num(0, { min: 0 }),
      sp: new f.TypedObjectField(num(0, { min: 0 })),
      ev: num(0, { min: 0 }),
      resistances: strings(),
      skillBonuses: new f.ArrayField(new f.SchemaField({ skill: str(), value: num(), condition: str() })),
      duration: num(),
      toxicity: num(),
      consumable: bool(),
      substance: str(),
      substanceUnits: num(1, { min: 0 }),
      craftDC: num(),
      craftTime: str(),
      craftLevel: str(),
      investment: num(),
      productName: str(),
      productQuantity: num(1),
      productUuid: str(),
      materials: new f.ArrayField(
        new f.SchemaField({ name: str(), quantity: num(1), uuid: str(), substance: str() })
      ),
      wound: new f.SchemaField({
        key: str(),
        name: str(),
        group: str(),
        severity: str('simple'),
        location: str(),
        treatment: str('untreated'),
        daysRemaining: num(),
        turnsTreated: num(),
        magicUses: num(0, { min: 0, integer: true }),
        daysTotal: num(0, { min: 0 }),
        recoveryBody: num(),
        recoveryPending: bool(),
        recoveryContext: str(),
        separateConditions: bool(),
        bonesOfGlass: bool(),
        endedConditions: strings(),
        extraResult: num(),
        notes: str(),
        modifiers: new f.ObjectField({ initial: {} }),
        stabilizedModifiers: new f.ObjectField({ initial: {} }),
        treatedModifiers: new f.ObjectField({ initial: {} }),
        healedModifiers: new f.ObjectField({ initial: {} }),
        damagePerTurn: num(),
        stabilizedDamagePerTurn: num(),
        stunEvery: num(),
        stabilizedStunEvery: num(),
        permanent: bool(),
        extraDamage: str(),
        lastTick: str(),
        bleeding: bool(),
        poison: bool(),
        suffocating: bool(),
        deathSave: bool(),
        fatal: bool(),
        organ: bool(),
        extraRoll: str(),
        stunEveryFormula: str(),
        ageRounds: num(),
      }),
      abilities: new f.ArrayField(
        new f.SchemaField({
          id: str(),
          name: str(),
          stat: str(),
          rank: num(),
          description: str(),
          requires: num(),
          cost: num(),
        })
      ),
      ability: new f.SchemaField({ key: str(), mode: str('reference') }),
    };
  }
}

export function itemSnapshot(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    flags: foundry.utils.deepClone(item.flags ?? {}),
    ...(item.system.toObject?.() ?? item.system),
  };
}
export function actorSnapshot(actor) {
  const state = {
    ...actor.system.toObject(),
    type: actor.type,
    id: actor.id,
    uuid: actor.uuid,
    flags: foundry.utils.deepClone(actor.flags ?? {}),
    items: actor.items.map(itemSnapshot),
  };
  if (state.effects.some((x) => x.key === 'Golden Oriole'))
    state.immunities = [...new Set([...state.immunities, 'poison'])];
  return state;
}

/** Persist a reduced STA ceiling without restoring points when it later rises.
 * Prepared data can already be capped while _source still contains the old value.
 * Projected items let a treatment transaction calculate its resulting ceiling.
 */
export function staminaCapChanges(actor, projectedItems) {
  const state = actorSnapshot(actor);
  const maximum = Math.max(0, derivedStats(state, projectedItems ?? state.items).staMax);
  return { 'system.sta.value': Math.min(actor.system.sta.value, maximum) };
}

export class WitcherActor extends Actor {
  getRollData() {
    return { ...this.system.toObject(), derived: this.system.derived };
  }
  async toggleStatusEffect(statusId, { active, ...options } = {}) {
    if (!Object.hasOwn(CONDITIONS, statusId))
      return super.toggleStatusEffect(statusId, { active, ...options });
    const enabled = active ?? !this.system.conditions.includes(statusId);
    await this.setCondition(statusId, enabled);
    return super.toggleStatusEffect(statusId, { active: enabled, ...options });
  }
  _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if (userId !== game.user.id || !foundry.utils.hasProperty(changed, 'system.conditions')) return;
    for (const id of Object.keys(CONDITIONS)) {
      const active = this.system.conditions.includes(id);
      if (this.statuses.has(id) !== active)
        super
          .toggleStatusEffect(id, { active })
          .catch((error) => console.error('Witcher status synchronization', error));
    }
  }
  async _preCreate(data, options, user) {
    await super._preCreate(data, options, user);
    const table = this.type === 'monster' ? MONSTER_LOCATIONS : HUMANOID_LOCATIONS;
    const source = {
      'prototypeToken.actorLink': this.type === 'character',
      'prototypeToken.bar1.attribute': 'hp',
      'prototypeToken.bar2.attribute': 'sta',
    };
    if (!data.system?.locations?.length) source['system.locations'] = structuredClone(table);
    this.updateSource(source);
  }
  prepareDerivedData() {
    super.prepareDerivedData();
    const state = actorSnapshot(this);
    try {
      this.system.derived = derivedStats(state, state.items);
      this.system.armorError = '';
    } catch (error) {
      this.system.derived = derivedStats(
        state,
        state.items.map((i) => ({ ...i, equipped: false }))
      );
      this.system.armorError = error.message;
    }
    this.system.hp.max = this.system.derived.hpMax;
    this.system.sta.max = Math.max(0, this.system.derived.staMax);
    this.system.sta.value = Math.min(this.system.sta.value, this.system.sta.max);
    this.system.luck.max = this.system.derived.base.luck;
    this.system.locationTable = hitLocations(state);
  }
  async _preUpdate(changes, options, user) {
    await super._preUpdate(changes, options, user);
    const expanded = foundry.utils.expandObject(changes);
    if (expanded.system?.locations) validateLocations(expanded.system.locations);
    if (this.system.hp.value <= 0 && expanded.system?.hp?.value > 0) {
      if (!Object.hasOwn(expanded.system, 'deathSaves')) changes['system.deathSaves'] = 0;
      if (!Object.hasOwn(expanded.system, 'pendingDeathSaves')) changes['system.pendingDeathSaves'] = 0;
    }
  }
  skillBase(key, { stat, modifier = 0, arm = '', sight = false, context = {}, substituted = false } = {}) {
    const magical = magicSkillRules(this.system, key, context);
    if (!substituted && magical.substitutions.length) {
      const choices = magical.substitutions.map(({ skill }) =>
        this.skillBase(skill, { modifier, arm, sight, context, substituted: true })
      );
      choices.push(this.skillBase(key, { stat, modifier, arm, sight, context, substituted: true }));
      return choices.sort((a, b) => b.total - a.total)[0];
    }
    const skill = SKILLS[key];
    const custom = this.system.customSkills.find(
      (s) => s.id === key || s.name.replace(/\s/g, '').toLowerCase() === key.toLowerCase()
    );
    const attribute = stat ?? skill?.[1] ?? custom?.stat ?? 'int';
    const rank = skill ? this.system.skills[key] : (custom?.rank ?? this.system.professionRanks[key] ?? 0);
    let bonus = hexSkillModifier(this.system, key, context);
    if (
      this.system.race === 'witcher' &&
      key === 'awareness' &&
      !this.items.some((i) => i.system.equipped && i.system.properties?.restrictedVision)
    )
      bonus++;
    if (this.system.race === 'elf') bonus += key === 'archery' ? 2 : key === 'fineArts' ? 1 : 0;
    if (this.system.race === 'dwarf') bonus += ['business', 'physique'].includes(key) ? 1 : 0;
    bonus += Number(magicModifierSummary(this.system, context).modifiers[key] ?? 0) + magical.bonus;
    if (key === 'awareness') {
      const light = this.system.environment.light;
      const cat = !!activeAlchemy(this.system, 'cat');
      if (!cat || light === 'bright')
        bonus +=
          light === 'bright'
            ? -3
            : light === 'dark'
              ? -4
              : ['dim', 'moonlight'].includes(light) &&
                  this.system.race !== 'witcher' &&
                  !this.system.traits.nightVision
                ? -2
                : 0;
      if (
        this.system.environment.underwater &&
        !this.system.traits.amphibious &&
        !activeAlchemy(this.system, 'killer-whale')
      )
        bonus -= 3;
    }
    if (context.seeThroughIllusion && activeAlchemy(this.system, 'cat')) bonus += 2;
    for (const item of this.items) {
      if (item.system.equipped)
        for (const b of item.system.skillBonuses ?? []) if (b.skill === key && !b.condition) bonus += b.value;
      if (item.type === 'wound') {
        const w = item.system.wound;
        const mods = woundModifiers(w);
        bonus += Number(mods?.[key] ?? 0);
      }
    }
    if (this.system.conditions.includes('grappled') && ['ref', 'dex', 'body', 'spd'].includes(attribute))
      bonus -= 2;
    bonus += Number(this.system.derived.mods.allActions ?? 0);
    bonus += woundCheckModifier([...this.items], { arm, sight: key === 'awareness' && sight });
    const multiplier = Number(this.system.derived.mods[key + 'Multiplier'] ?? 1);
    const feralInt = this.system.traits.feralInt || (this.system.transport.feral ? 7 : 0);
    const statValue =
      feralInt && ['awareness', 'wildernessSurvival'].includes(key)
        ? Math.max(
            1,
            Math.floor(
              (feralInt + Number(this.system.derived.mods.int ?? 0)) /
                (this.system.derived.dying ? 3 : this.system.derived.wound ? 2 : 1)
            )
          )
        : this.system.derived.stats[attribute];
    return {
      stat: attribute,
      statValue,
      rank,
      bonus,
      modifier,
      total: Math.floor((statValue + rank + bonus) * multiplier) + modifier,
    };
  }
  async setCondition(condition, enabled = true) {
    if (!Object.hasOwn(CONDITIONS, condition)) throw new RuleError('Unknown condition');
    if (enabled && immuneTo(actorSnapshot(this), condition))
      throw new RuleError(`This actor is immune to ${condition}.`);
    const set = new Set(this.system.conditions);
    if (enabled) set.add(condition);
    else set.delete(condition);
    await this.update({ 'system.conditions': [...set] });
  }
  async improveSkill(key) {
    if (!SKILLS[key]) throw new RuleError('Unknown skill');
    const current = this.system.skills[key];
    const cost = skillImprovementCost(current, SKILLS[key][2] === 2);
    if (this.system.ip < cost) throw new RuleError(`Improvement requires ${cost} IP`);
    await this.update({ [`system.skills.${key}`]: current + 1, 'system.ip': this.system.ip - cost });
  }
  async rest({ days = 1, strenuous = false, sleepHours = 8, meals = 3, nightmareDice = {} } = {}) {
    if (!Number.isInteger(days) || days < 1) throw new RuleError('Enter a positive whole number of days');
    const hexes = activeHexes(this.system);
    if (days !== 1 && (hexes.has('the-nightmare') || hexes.has('unending-need')))
      throw new RuleError('Resolve one night at a time while this rest-affecting hex is active.');
    const nightmareTotals = {},
      nightmareRolls = [];
    for (const effect of this.system.effects.filter(
      (effect) => effect.magic?.key === 'the-nightmare' && activeHexes({ effects: [effect] }).size
    )) {
      const roll = await check(this.skillBase('resistCoercion').total, {
        actor: this,
        manualDice: nightmareDice[effect.id],
        context: { dc: effect.magic.castingTotal, skill: 'resistCoercion' },
      });
      nightmareTotals[effect.id] = roll.total;
      nightmareRolls.push({ effect, roll });
    }
    const hexRest = hexRestPlan(this.system.toObject(), {
      sleepHours,
      meals,
      time: game.time.worldTime,
      nightmareTotals,
    });
    const projected = { ...actorSnapshot(this), effects: hexRest.effects };
    const after = derivedStats(projected, projected.items);
    const heal = this.system.healingEnabled
      ? Math.floor((this.system.derived.rec + this.system.healingBonus) * (strenuous ? 0.5 : 1)) * days
      : 0;
    const changes = {
      'system.hp.value': Math.min(
        this.system.hp.max,
        this.system.hp.value +
          (hexRest.recoveryAllowed
            ? magicRecoveryRules(this.system, { source: 'natural', amount: heal }).hpAmount
            : 0)
      ),
      'system.sta.value': hexRest.recoveryAllowed
        ? after.staMax
        : Math.min(this.system.sta.value, after.staMax),
      'system.effects': hexRest.effects,
    };
    const updates = [];
    const recoveryState = actorSnapshot(this);
    for (const w of this.items.filter(
      (i) =>
        i.type === 'wound' &&
        i.system.wound.treatment === 'treated' &&
        !i.system.wound.permanent &&
        !lastHopeLocked(i)
    )) {
      const patch = recoveryClockChanged(w.system.wound, recoveryState, recoveryState.items)
        ? { recoveryPending: true }
        : advanceWoundDays(w.system.wound, days);
      if (patch)
        updates.push({
          _id: w.id,
          ...Object.fromEntries(Object.entries(patch).map(([k, v]) => ['system.wound.' + k, v])),
        });
    }
    if (this.system.traits.regeneration > 0) {
      for (const item of this.items.filter(
        (i) => i.type === 'weapon' && i.system.properties.natural && i.system.maxReliability > 0
      )) {
        updates.push({
          _id: item.id,
          'system.reliability': Math.min(item.system.maxReliability, item.system.reliability + days),
        });
      }
    }
    await commitActor(this, changes, updates, async () => {
      if (nightmareRolls.length)
        return chat(
          this,
          'Nightmare: nightly resistance',
          nightmareRolls
            .map(
              ({ effect, roll }) =>
                checkHTML(roll) +
                `<p>DC ${effect.magic.castingTotal}: ${roll.total > effect.magic.castingTotal ? 'Sleep and recovery allowed.' : 'No HP or STA recovered tonight.'}</p>`
            )
            .join(''),
          { rolls: nightmareRolls.flatMap(({ roll }) => roll.rolls) }
        );
    });
  }
}

export class WitcherItem extends Item {
  async _preCreate(data, options, user) {
    await super._preCreate(data, options, user);
    if (this.type === 'wound' && this.parent?.system) {
      const upgraded = hexCriticalWound(this.parent.system, data.system?.wound, WOUNDS);
      if (upgraded !== data.system?.wound) {
        const canonical = woundItemData(upgraded);
        this.updateSource({
          name: canonical.name,
          'system.wound': canonical.system.wound,
          'system.description': canonical.system.description,
        });
      }
    }
    if (!data.img || data.img === 'icons/svg/item-bag.svg')
      this.updateSource({
        img:
          this.type === 'weapon'
            ? 'icons/svg/sword.svg'
            : this.type === 'armor' || this.type === 'shield'
              ? 'icons/svg/shield.svg'
              : this.type === 'wound'
                ? 'icons/svg/blood.svg'
                : 'icons/svg/item-bag.svg',
      });
  }
  async roll() {
    if (!this.actor) throw new RuleError('Drag the item onto an actor first');
    return game.witcher.attack(this.actor, this);
  }
}
