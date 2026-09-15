import {STATS, SKILLS, HUMANOID_LOCATIONS, MONSTER_LOCATIONS, CONDITIONS, SYSTEM_ID} from "./config.js";
import {derivedStats, hitLocations, validateLocations, RuleError, skillImprovementCost, beats} from "./rules.js";

const f=foundry.data.fields;
const num=(initial=0,options={})=>new f.NumberField({initial,required:true,nullable:false,...options});
const str=(initial="")=>new f.StringField({initial,required:true,nullable:false});
const bool=(initial=false)=>new f.BooleanField({initial});
const strings=()=>new f.ArrayField(str());
const resource=(initial=25)=>new f.SchemaField({value:num(initial),max:num(initial,{min:0})});
const numericObject=(keys,value=0)=>new f.SchemaField(Object.fromEntries(keys.map(k=>[k,num(value)])));
const locationField=()=>new f.SchemaField({id:str(),label:str(),group:str(),min:num(1,{integer:true,min:1,max:10}),max:num(1,{integer:true,min:1,max:10}),aim:num(),multiplier:num(1,{min:0}),sp:num(0,{min:0}),maxSp:num(0,{min:0})});

export class WitcherActorData extends foundry.abstract.TypeDataModel {
  static defineSchema(){return {
    stats:numericObject(STATS,5),statModifiers:numericObject(STATS),skills:numericObject(Object.keys(SKILLS)),
    hp:resource(),sta:resource(),luck:resource(5),toxicity:resource(0),coins:num(0,{min:0}),ip:num(0,{min:0}),
    race:str("human"),profession:str(),age:num(20),gender:str(),homeland:str(),biography:new f.HTMLField({initial:""}),
    anatomy:str("humanoid"),locations:new f.ArrayField(locationField()),conditions:strings(),
    resistances:strings(),naturalResistances:strings(),immunities:strings(),vulnerabilities:strings(),silverVulnerable:bool(),meteoriteVulnerable:bool(),
    majorNpc:bool(),size:str("medium"),ignoredEV:num(),deathSaves:num(0,{integer:true,min:0}),pendingDeathSaves:num(0,{integer:true,min:0}),
    unconsciousRecovery:num(),healingEnabled:bool(),healingBonus:num(),
    overrides:numericObject(["hp","sta","enc","rec","stun","meleeBonus"]),
    combat:new f.SchemaField({key:str(),roundKey:str(),actions:num(),extra:num(),defenses:num(),remaining:num(),weaponId:str(),style:str(),extraPenalty:num(),aim:num(),grappledBy:str(),grappling:str(),applied:strings(),lastEffectTurn:str(),hitThisRound:bool()}),
    environment:new f.SchemaField({light:str("daylight"),underwater:bool(),swamp:bool(),ice:bool(),heat:bool()}),
    notes:str(),reputation:num(),organless:bool(),mountUuid:str(),mountDistance:num(),
    effects:new f.ArrayField(new f.ObjectField()),
    professionRanks:new f.TypedObjectField(num()),customSkills:new f.ArrayField(new f.SchemaField({id:str(),name:str(),stat:str("int"),rank:num(),difficult:bool()}))
  };}
}
export class WitcherMonsterData extends WitcherActorData {
  static defineSchema(){return {...super.defineSchema(),anatomy:str("monster"),silverVulnerable:bool(true),category:str("monster"),notes:str()};}
}
export class WitcherItemData extends foundry.abstract.TypeDataModel {
  static defineSchema(){return {
    description:new f.HTMLField({initial:""}),source:str(),page:num(),quantity:num(1,{min:0}),weight:num(0,{min:0}),cost:num(0,{min:0}),
    carried:bool(true),equipped:bool(),category:str(),availability:str(),concealment:str(),notes:str(),effectText:str(),priceText:str(),relic:bool(),
    bonuses:new f.TypedObjectField(num()),forageDC:num(),forageLocation:str(),forageQuantity:str(),
    attachments:new f.ArrayField(new f.ObjectField()),oil:new f.SchemaField({name:str(),expires:num()}),memorized:bool(),
    mount:new f.SchemaField({athletics:num(),control:num(),speed:num(),speedModifier:num(),hp:num(),maxHp:num(),ramDamage:str()}),
    skill:str("melee"),stat:str("ref"),rank:num(0,{min:0}),difficult:bool(),
    damage:str("1d6"),damageTypes:strings(),accuracy:num(),reliability:num(10,{min:0}),maxReliability:num(10,{min:0}),
    hands:num(1,{integer:true,min:0,max:2}),range:num(),rangeBodyMultiplier:num(),rof:num(1,{integer:true,min:1}),
    loaded:bool(true),ammoId:str(),isAmmo:bool(),ammoCategory:str(),enhancements:num(0,{min:0}),
    properties:new f.SchemaField({armorPiercing:bool(),improvedArmorPiercing:bool(),ablating:bool(),bleeding:num(),poison:num(),fire:num(),stun:num(),
      balanced:bool(),silver:bool(),meteorite:bool(),silverDamage:str(),nonlethal:bool(),longReach:bool(),grappling:bool(),brawling:bool(),slowReload:bool(),concealment:bool(),
      focus:num(),greaterFocus:bool(),burrower:bool(),area:num(),allLocations:bool(),parrying:bool(),restrictedVision:bool(),fullCover:bool(),selfStanding:bool(),
      freeze:num(),stagger:num(),stunWeapon:bool(),balancedBonus:num(),natural:bool()}),
    armorClass:str("light"),coverage:strings(),stoppingPower:num(0,{min:0}),sp:new f.TypedObjectField(num(0,{min:0})),ev:num(0,{min:0}),resistances:strings(),
    skillBonuses:new f.ArrayField(new f.SchemaField({skill:str(),value:num(),condition:str()})),
    duration:num(),toxicity:num(),consumable:bool(),substance:str(),substanceUnits:num(1,{min:0}),
    craftDC:num(),craftTime:str(),craftLevel:str(),investment:num(),productName:str(),productQuantity:num(1),productUuid:str(),materials:new f.ArrayField(new f.SchemaField({name:str(),quantity:num(1),uuid:str(),substance:str()})),
    wound:new f.SchemaField({severity:str("simple"),location:str(),treatment:str("untreated"),daysRemaining:num(),turnsTreated:num(),
      modifiers:new f.ObjectField({initial:{}}),stabilizedModifiers:new f.ObjectField({initial:{}}),treatedModifiers:new f.ObjectField({initial:{}}),
      damagePerTurn:num(),stabilizedDamagePerTurn:num(),stunEvery:num(),stabilizedStunEvery:num(),permanent:bool(),extraDamage:str(),lastTick:str(),
      bleeding:bool(),poison:bool(),suffocating:bool(),deathSave:bool(),fatal:bool(),organ:bool(),extraRoll:str(),stunEveryFormula:str(),ageRounds:num()}),
    abilities:new f.ArrayField(new f.SchemaField({id:str(),name:str(),stat:str(),rank:num(),description:str(),requires:num(),cost:num()}))
  };}
}

export function itemSnapshot(item){return {id:item.id,type:item.type,name:item.name,...item.system.toObject?.()??item.system};}
export function actorSnapshot(actor){return {...actor.system.toObject(),type:actor.type,id:actor.id,uuid:actor.uuid,items:actor.items.map(itemSnapshot)};}

export class WitcherActor extends Actor {
  getRollData(){return {...this.system.toObject(),derived:this.system.derived};}
  async _preCreate(data,options,user){
    await super._preCreate(data,options,user);
    const table=this.type==="monster"?MONSTER_LOCATIONS:HUMANOID_LOCATIONS;
    const source={"prototypeToken.actorLink":this.type==="character","prototypeToken.bar1.attribute":"hp","prototypeToken.bar2.attribute":"sta"};
    if(!data.system?.locations?.length)source["system.locations"]=structuredClone(table);
    this.updateSource(source);
  }
  prepareDerivedData(){
    super.prepareDerivedData();
    const state=actorSnapshot(this);
    try{this.system.derived=derivedStats(state,state.items);this.system.armorError="";}
    catch(error){this.system.derived=derivedStats(state,state.items.map(i=>({...i,equipped:false})));this.system.armorError=error.message;}
    this.system.hp.max=this.system.derived.hpMax;this.system.sta.max=this.system.derived.staMax;
    this.system.luck.max=this.system.derived.base.luck;
    this.system.locationTable=hitLocations(state);
  }
  async _preUpdate(changes,options,user){
    await super._preUpdate(changes,options,user);
    const expanded=foundry.utils.expandObject(changes);
    if(expanded.system?.locations)validateLocations(expanded.system.locations);
    if(expanded.system?.hp?.value>0){changes["system.deathSaves"]=0;changes["system.pendingDeathSaves"]=0;}
  }
  skillBase(key,{stat,modifier=0}={}){
    const skill=SKILLS[key];const custom=this.system.customSkills.find(s=>s.id===key);
    const attribute=stat??skill?.[1]??custom?.stat??"int";
    const rank=skill?this.system.skills[key]:custom?.rank??this.system.professionRanks[key]??0;
    let bonus=0;
    if(this.system.race==="witcher"&&key==="awareness"&&!this.items.some(i=>i.system.equipped&&i.system.properties?.restrictedVision))bonus++;
    if(this.system.race==="elf")bonus+=key==="archery"?2:key==="fineArts"?1:0;
    if(this.system.race==="dwarf")bonus+=["business","physique"].includes(key)?1:0;
    for(const item of this.items){
      if(item.system.equipped)for(const b of item.system.skillBonuses??[])if(b.skill===key&&!b.condition)bonus+=b.value;
      if(item.type==="wound"){
        const w=item.system.wound;const mods=w.treatment==="treated"?w.treatedModifiers:w.treatment==="stabilized"?w.stabilizedModifiers:w.modifiers;
        bonus+=Number(mods?.[key]??0);
      }
    }
    if(this.system.conditions.includes("grappled")&&["ref","dex","body","spd"].includes(attribute))bonus-=2;
    bonus+=Number(this.system.derived.mods.allActions??0);
    const multiplier=Number(this.system.derived.mods[key+'Multiplier']??1);
    return {stat:attribute,statValue:this.system.derived.stats[attribute],rank,bonus,modifier,total:Math.floor((this.system.derived.stats[attribute]+rank+bonus)*multiplier)+modifier};
  }
  async setCondition(condition,enabled=true){
    if(!Object.hasOwn(CONDITIONS,condition))throw new RuleError("Unknown condition");
    const set=new Set(this.system.conditions);if(enabled)set.add(condition);else set.delete(condition);
    await this.update({"system.conditions":[...set]});
  }
  async improveSkill(key){
    if(!SKILLS[key])throw new RuleError("Unknown skill");
    const current=this.system.skills[key];const cost=skillImprovementCost(current,SKILLS[key][2]===2);
    if(this.system.ip<cost)throw new RuleError(`Improvement requires ${cost} IP`);
    await this.update({[`system.skills.${key}`]:current+1,"system.ip":this.system.ip-cost});
  }
  async rest({days=1,strenuous=false}={}){
    if(!Number.isInteger(days)||days<1)throw new RuleError("Enter a positive whole number of days");
    const heal=this.system.healingEnabled?Math.floor((this.system.derived.rec+this.system.healingBonus)*(strenuous?.5:1))*days:0;
    await this.update({"system.hp.value":Math.min(this.system.hp.max,this.system.hp.value+heal),"system.sta.value":this.system.sta.max});
    const updates=[];const healed=[];
    for(const w of this.items.filter(i=>i.type==="wound"&&i.system.wound.treatment==="treated"&&!i.system.wound.permanent)){
      const remaining=Math.max(0,w.system.wound.daysRemaining-days);
      if(remaining===0)healed.push(w.id);else updates.push({_id:w.id,"system.wound.daysRemaining":remaining});
    }
    if(updates.length)await this.updateEmbeddedDocuments("Item",updates);
    if(healed.length)await this.deleteEmbeddedDocuments("Item",healed);
  }
}

export class WitcherItem extends Item {
  async _preCreate(data,options,user){await super._preCreate(data,options,user);if(!data.img||data.img==="icons/svg/item-bag.svg")this.updateSource({img:this.type==="weapon"?"icons/svg/sword.svg":this.type==="armor"||this.type==="shield"?"icons/svg/shield.svg":this.type==="wound"?"icons/svg/blood.svg":"icons/svg/item-bag.svg"});}
  async roll(){if(!this.actor)throw new RuleError("Drag the item onto an actor first");return game.witcher.attack(this.actor,this);}
}
