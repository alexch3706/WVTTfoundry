import {HUMANOID_LOCATIONS, MONSTER_LOCATIONS, STATS} from "./config.js";
import {combinedModifiers} from './wounds.js';

export class RuleError extends Error {}
const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Printed pp.57,156: a fumble discards the initial one and subtracts the continuation. */
export function resolveCheck(base, dice) {
  if (!Number.isFinite(base) || !Array.isArray(dice) || !dice.length || dice.some(d => !Number.isInteger(d) || d < 1 || d > 10)) throw new RuleError("Invalid d10 check");
  const first = dice[0];
  const continued = first === 1 || first === 10;
  if (continued && (dice.length < 2 || dice.at(-1) === 10 || dice.slice(1, -1).some(d => d !== 10))) throw new RuleError("Incomplete exploding die sequence");
  if (!continued && dice.length !== 1) throw new RuleError("Unexpected continuation");
  const continuation = dice.slice(1).reduce((a,b) => a+b, 0);
  const contribution = first === 1 ? -continuation : dice.reduce((a,b) => a+b, 0);
  return {base, dice: [...dice], contribution, total: Math.max(0, base + contribution), fumble: first === 1 ? continuation : 0, critical: first === 10};
}
export const beats = (roll, difficulty) => n(roll) > n(difficulty);
export function criticalSeverity(margin) {
  for (const [threshold, level, bonus] of [[15,"deadly",10],[13,"difficult",8],[10,"complex",5],[7,"simple",3]]) {
    if (margin >= threshold) return {level, bonus, margin};
  }
  return null;
}

export function hitLocations(actor = {}) {
  const table = actor.anatomy === "custom" ? actor.locations : actor.anatomy === "monster" ? MONSTER_LOCATIONS : HUMANOID_LOCATIONS;
  if (!table?.length) throw new RuleError("A hit-location table is required");
  return table.map(l => ({...l, ...(actor.locations?.find(x => x.id === l.id) ?? {})}));
}
export function validateLocations(table) {
  const ids = new Set();
  for (const l of table) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(l.id) || ids.has(l.id)) throw new RuleError("Locations must have unique identifiers");
    ids.add(l.id);
    if (![l.min,l.max,l.aim,l.multiplier].every(Number.isFinite) || l.min < 1 || l.max > 10 || l.min > l.max || l.multiplier < 0) throw new RuleError("Invalid hit location");
  }
  for (let roll=1;roll<=10;roll++) if (table.filter(l => roll >= l.min && roll <= l.max).length !== 1) throw new RuleError(`Hit location roll ${roll} must match exactly one location`);
  return true;
}
export function locate(table, rollOrId) {
  validateLocations(table);
  const result = table.find(l => typeof rollOrId === "string" ? l.id === rollOrId : rollOrId >= l.min && rollOrId <= l.max);
  if (!result) throw new RuleError("The target does not have this hit location");
  return {...result};
}

/** Printed p.155, including the worked 3 + 12 + 20 = 24 example. */
export function armorBonus(difference) {
  difference = Math.abs(difference);
  return difference <= 4 ? 5 : difference <= 8 ? 4 : difference <= 14 ? 3 : difference <= 20 ? 2 : 0;
}
export function stackArmor(layers) {
  const worn = layers.filter(l => l.kind !== "natural");
  if (worn.length > 3 || worn.filter(l=>l.kind==="heavy").length>1 || worn.filter(l=>l.kind==="medium").length>1) throw new RuleError("Maximum three worn armor layers, including at most one medium and one heavy (p.154)");
  const values = layers.map(l=>Math.max(0,n(l.sp))).filter(x=>x>0).sort((a,b)=>a-b);
  if (!values.length) return 0;
  return values.slice(1).reduce((combined,next)=>Math.max(combined,next)+Math.min(Math.min(combined,next),armorBonus(combined-next)),values[0]);
}
export function armorAt(items, location) {
  return items.filter(i=>i.type==="armor" && i.equipped && i.coverage?.includes(location.id)).map(i=>({id:i.id, kind:i.armorClass, sp:n(i.sp?.[location.id] ?? i.stoppingPower), resistances:i.resistances??[]}));
}
export function armorEncumbrance(items) {
  const worn = items.filter(i=>(i.type==="armor"||i.type==="shield")&&i.equipped);
  const locations = new Set(worn.flatMap(i=>i.coverage??[]));
  let layering = 0;
  for (const loc of locations) {
    const layers=worn.filter(i=>i.type==="armor"&&i.coverage?.includes(loc));
    stackArmor(layers.map(i=>({kind:i.armorClass,sp:i.stoppingPower})));
    if(layers.length>1) layering=Math.max(layering,layers.reduce((v,l)=>v+(l.armorClass==="medium"?1:l.armorClass==="heavy"?2:0),0));
  }
  return worn.reduce((sum,i)=>sum+n(i.ev),0)+layering;
}

/** A pure result: the caller persists planned changes once, after GM confirmation. */
export function resolveDamage({raw, silver=0, type="slashing", properties={}, multiplier=1, nonlethal=false, cover=0, criticalBonus=0}, target, location, items=[]) {
  if (![raw,silver,multiplier,cover,criticalBonus].every(Number.isFinite)||raw<0||silver<0) throw new RuleError("Invalid damage values");
  const layers=armorAt(items,location);
  const natural={kind:"natural",id:location.id,sp:Math.max(0,n(location.sp)),resistances:target.naturalResistances??[]};
  const worn=properties.bypassArmor?0:stackArmor(layers);
  // Natural armor is a separate inherent protection; it does not consume a clothing layer.
  const originalSp=(properties.bypassArmor?0:natural.sp+(target.race==="dwarf"?2:0))+worn;
  const sp=properties.improvedArmorPiercing?Math.ceil(originalSp/2):originalSp;
  const isSilverTarget=target.silverVulnerable===true;
  const rolled=Math.max(0,(raw+(isSilverTarget?silver:0))*multiplier);
  const afterCover=Math.max(0,rolled-Math.max(0,cover));
  const afterArmor=Math.max(0,afterCover-sp);
  let resisted=afterArmor;
  const armorResistant=[...layers.flatMap(l=>l.resistances),...natural.resistances].includes(type);
  if(armorResistant&&!properties.armorPiercing&&!properties.improvedArmorPiercing&&!properties.bypassArmor) resisted/=2;
  if(target.immunities?.includes(type))resisted=0;
  else {
    if(target.resistances?.includes(type))resisted/=2;
    if(isSilverTarget&&!properties.silver&&type!=="fire"&&!(properties.meteorite&&target.meteoriteVulnerable))resisted/=2;
    if(target.vulnerabilities?.includes(type))resisted*=2;
  }
  const localized=Math.max(0,Math.floor(resisted*location.multiplier));
  const penetrated=afterArmor>0;
  const wear=properties.bypassArmor?0:(penetrated?1+n(properties.ablation):0)+n(properties.alwaysAblate);
  return {
    location:{...location}, raw, silver:isSilverTarget?silver:0, multiplier, rolled, cover, afterCover,
    sp, afterArmor, resisted, localized, criticalBonus, damage:localized+criticalBonus, nonlethal,
    armorChanges:layers.map(l=>({id:l.id,location:location.id,before:l.sp,after:Math.max(0,l.sp-wear)})).filter(l=>l.before!==l.after),
    naturalChange:{location:location.id,before:natural.sp,after:Math.max(0,natural.sp-wear)}, penetrated,
    clearsStun:true
  };
}

export function meleeBonus(body) {return body<=2?-4:body<=4?-2:body<=6?0:body<=8?2:body<=10?4:body<=12?6:8;}
export function derivedStats(actor, items=[]) {
  const mods=combinedModifiers(actor,items);
  const base=Object.fromEntries(STATS.map(k=>[k,Math.max(1,n(actor.stats?.[k],5))]));
  if(actor.race==="witcher"){base.ref+=1;base.dex+=1;base.emp=Math.max(1,base.emp-4);}
  const physical=Math.floor((base.body+base.will)/2);
  const hpMax=(n(actor.overrides?.hp)||physical*5)+n(mods.hp);
  const staMax=Math.floor(((n(actor.overrides?.sta)||physical*5)+n(mods.sta))*n(mods.staMultiplier,1));
  const enc=Math.max(0,((n(actor.overrides?.enc)||(base.body*10+(actor.race==="dwarf"?25:0)))+n(mods.enc))*n(mods.encMultiplier,1));
  const weight=items.filter(i=>i.carried!==false).reduce((sum,i)=>sum+n(i.weight)*Math.max(0,n(i.quantity,1)),0)+Math.max(0,n(actor.coins))*.001;
  const overweight=Math.max(0,Math.floor((weight-enc)/5));
  const ev=Math.max(0,armorEncumbrance(items)-n(actor.ignoredEV));
  const conditions=new Set(actor.conditions??[]);
  const wound=actor.hp?.value < hpMax/5;
  const dying=actor.hp?.value <= 0;
  const current={...base};
  for(const key of STATS){
    let modifier=n(mods[key]);
    if(["ref","dex","spd"].includes(key))modifier-=overweight;
    if(["ref","dex"].includes(key))modifier-=ev;
    if(conditions.has("frozen"))modifier-=key==="spd"?3:key==="ref"?1:0;
    if(conditions.has("intoxicated")&&["ref","dex","int"].includes(key))modifier-=2;
    current[key]=Math.max(1,Math.floor((base[key]+modifier)*n(mods[key+'Multiplier'],1)/(dying?3:wound&&["ref","dex","int","will"].includes(key)?2:1)));
  }
  return {base,stats:current,mods,hpMax,staMax,stun:Math.max(1,Math.floor(((n(actor.overrides?.stun)||Math.min(10,physical))+n(mods.stun))/(dying?3:1))),deathTarget:n(actor.overrides?.stun)||Math.min(10,physical),
    rec:Math.max(1,Math.floor(((n(actor.overrides?.rec)||physical)+n(mods.rec))*n(mods.recMultiplier,1)/(dying?3:1))),enc,weight,overweight,ev,wound,dying,
    run:current.spd*3,leap:Math.floor(current.spd*3/5),meleeBonus:(n(actor.overrides?.meleeBonus)||meleeBonus(current.body))+n(mods.meleeBonus),
    punch:`1d6${meleeBonus(current.body)>=0?"+":""}${meleeBonus(current.body)}`,
    kick:`1d6+${4+meleeBonus(current.body)}`,woundThreshold:Math.floor(hpMax/5)};
}

export function rangeBracket(distance, range) {
  if(!Number.isFinite(distance)||distance<0||!Number.isFinite(range)||range<=0)throw new RuleError("A measured distance and positive weapon range are required");
  if(distance<=.5)return {name:"Point blank",dc:10,modifier:5};
  for(const [factor,name,dc,modifier] of [[.25,"Close",15,0],[.5,"Medium",20,-2],[1,"Long",25,-4],[2,"Extreme",30,-6]])if(distance<=range*factor)return {name,dc,modifier};
  throw new RuleError("Target is beyond twice the listed range");
}
export function strikeProfile(weapon, {style="fast",action="normal",npc=false,underwater=false}={}) {
  const ranged=["bow","crossbow","thrown"].includes(weapon.category);
  if(npc){if(style!=="normal")throw new RuleError("Minor NPCs/monsters use weapon ROF, not fast/strong strikes (p.153)");return {attacks:underwater?1:Math.max(1,n(weapon.rof,1)),modifier:0,multiplier:1};}
  if(weapon.category==="crossbow"&&style!=="normal")throw new RuleError("Crossbows do not use fast or strong strikes");
  if(!["normal","punch","kick"].includes(action))return {attacks:action==="joint"?2:1,modifier:action==="joint"||action==="charge"?-3:0,multiplier:action==="charge"?2:action==="pommel"||action==="pushKick"?.5:1};
  return {attacks:style==="fast"&&!['bow','crossbow','bomb','trap'].includes(weapon.category)&&!underwater?2:1,modifier:style==="strong"?-3:0,multiplier:style==="strong"?2:1};
}
export function defenseModifier(type, attackCategory) {
  if(type==="parry"&&["bow","crossbow"].includes(attackCategory))throw new RuleError("Bow and crossbow projectiles cannot be parried (p.164)");
  if(type==="blockWeapon"&&["bow","crossbow","thrown"].includes(attackCategory))throw new RuleError("Only a shield can block a ranged attack (p.164)");
  return type==="parry"?(attackCategory==="thrown"?-5:-3):0;
}
export function reserveAction(budget, {extra=false,full=false,strikes=1,defense=false,activelyDodging=false}={}) {
  const next={actions:n(budget.actions),extra:n(budget.extra),defenses:n(budget.defenses)};
  if(defense){next.defenses++;return {budget:next,cost:activelyDodging||next.defenses===1?0:1,modifier:0};}
  if(extra){if(next.extra>=1)throw new RuleError("Only one extra action per turn (p.151)");next.extra++;return {budget:next,cost:3,modifier:-3};}
  if(next.actions>=1)throw new RuleError("Your normal action is already spent");
  next.actions=1;
  return {budget:next,cost:0,modifier:0,full,strikes};
}
export function skillImprovementCost(current, difficult=false) {if(!Number.isInteger(current)||current<0||current>=10)throw new RuleError("Skill ranks must be 0–9 to improve");return Math.max(1,current)*(difficult?2:1);}
export function criticalHealingDays(body,severity){return severity==="deadly"?null:Math.max(1,({simple:8,complex:12,difficult:15}[severity]??NaN)-body);}
export function skillHeal(roll, {kind="firstAid",rest=true,rec=0}={}) {return beats(roll,14)?Math.max(0,Math.floor((rec+(kind==="healingHands"?3:0))*(rest?1:.5))):0;}
