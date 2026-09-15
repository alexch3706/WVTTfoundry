import {SYSTEM_ID,SKILLS,SPECIAL_ACTIONS} from './config.js';
import {RuleError,locate,hitLocations,strikeProfile,rangeBracket,defenseModifier,criticalSeverity,resolveDamage,beats} from './rules.js';
import {criticalWound,fumbleText} from './wounds.js';
import {actorSnapshot,itemSnapshot} from './documents.js';
import {measureTokenDistance,isPrimaryActiveGm} from '../foundry-compat.js';
import {owner,prompt,input,check,dice,chat,checkHTML,escapeHTML as e,actionPlan,commitActor,serial,actorFromUuid,save,errorNotice} from './runtime.js';

const RANGED=['bow','crossbow','thrown','bomb'];
const NO_DAMAGE=['disarm','takeWeapon','trip','grapple','pin','choke','escape','feint'];
const titleCase=text=>text.replace(/([A-Z])/g,' $1').replace(/^./,s=>s.toUpperCase());
const snapshotRoll=result=>({base:result.base,dice:result.dice,total:result.total,fumble:result.fumble});
const has= (actor,status)=>actor.system.conditions.includes(status);
const tokenFor=actor=>actor.token?.object??actor.getActiveTokens()?.[0];

function combatModifier(actor,{defense=false,melee=false}={}){
  let result=0;const reasons=[];
  for(const [status,value] of [['prone',-2],['staggered',-2],['blinded',-3]])if(has(actor,status)){result+=value;reasons.push(`${status} ${value}`);}
  const env=actor.system.environment;
  if(env.light==='dark'&&!actor.system.effects.some(x=>x.key==='Cat')){result-=2;reasons.push('darkness -2');}
  if(env.light==='bright'){result-=3;reasons.push('facing bright light -3');}
  if(env.underwater&&melee){result-=2;reasons.push('underwater -2');}
  return {modifier:result,reasons};
}
function unarmed(actor,action){
  return {id:'unarmed',name:titleCase(action),type:'weapon',category:'brawling',skill:'brawling',stat:'ref',hands:1,reliability:1,damage:action==='kick'||action==='pushKick'?actor.system.derived.kick:actor.system.derived.punch,damageTypes:['bludgeoning'],accuracy:0,rof:1,properties:{nonlethal:true,natural:true}};
}
function validateHands(actor,weapon){
  if(weapon.properties?.natural)return;
  const held=actor.items.filter(i=>i.system.equipped&&['weapon','shield'].includes(i.type));
  if(held.reduce((sum,i)=>sum+i.system.hands,0)>2)throw new RuleError('Equipped weapons and shields require more than two hands.');
  for(const w of actor.items.filter(i=>i.type==='wound')){
    const state=w.system.wound;const mods=state.treatment==='treated'?state.treatedModifiers:state.treatment==='stabilized'?state.stabilizedModifiers:state.modifiers;
    if(mods.armDisabled&&held.reduce((sum,i)=>sum+i.system.hands,0)>1)throw new RuleError('A disabled arm cannot hold a weapon.');
  }
}

export async function attack(actor,item,options={}){
  owner(actor);
  const target=options.target??[...game.user.targets][0]?.actor;
  if(!target)throw new RuleError('Target a token before attacking.');
  if(actor.system.armorError)throw new RuleError(actor.system.armorError);
  const weapon=item?itemSnapshot(item):unarmed(actor,options.action??'punch');
  if(weapon.type!=='weapon')throw new RuleError('Choose a weapon or an unarmed attack.');
  const minor=actor.type!=='character'&&!actor.system.majorNpc;
  const ranged=RANGED.includes(weapon.category);
  const table=hitLocations(actorSnapshot(target));
  const continuing=actor.system.combat.remaining>0&&actor.system.combat.weaponId===weapon.id&&(!game.combat?.started||actor.system.combat.key===`${game.combat.id}:${game.combat.round}:${game.combat.turn}`);
  const distance=measureTokenDistance(tokenFor(actor),tokenFor(target));
  const fields=
    `<p>${e(actor.name)} → ${e(target.name)} · ${e(weapon.name)}</p>`+
    input('style','Strike',{value:continuing?actor.system.combat.style:minor||weapon.category==='crossbow'?'normal':'fast',options:minor||weapon.category==='crossbow'?{normal:'Normal / ROF'}:{fast:'Fast',strong:'Strong',normal:'Single'}})+
    input('action','Action',{value:options.action??'normal',options:Object.fromEntries(SPECIAL_ACTIONS.filter(k=>k!=='joint').map(k=>[k,titleCase(k)]))})+
    input('location','Aim at location',{value:'',options:{'':'Random',...Object.fromEntries(table.map(l=>[l.id,`${l.label} (${l.aim})`]))}})+
    input('type','Damage type',{value:weapon.damageTypes?.[0]??'bludgeoning',options:Object.fromEntries((weapon.damageTypes?.length?weapon.damageTypes:['bludgeoning']).map(t=>[t,titleCase(t)]))})+
    (ranged?input('distance','Distance (metres)',{value:distance??'',min:0,step:.1}):'')+
    input('cover','Cover stopping power',{value:0,min:0})+input('modifier','Other attack modifiers',{value:0})+
    input('luck','Luck spent',{value:0,min:0,max:actor.system.luck.value})+
    input('extra','Extra action: 3 STA, −3',{type:'checkbox'})+
    input('outside','Target outside your vision cone (−3; no aiming)',{type:'checkbox'})+
    input('rear','You are outside the defender’s vision cone (+3)',{type:'checkbox'})+
    input('ambush','Successful ambush (+5 to the first strike)',{type:'checkbox'});
  const values=options.values??await prompt('Attack',fields,{button:continuing?'Next strike':'Attack',width:510});
  if(!values)return;
  return serial(actor.uuid,async()=>{
    let {action,style,location}=values;
    if(!SPECIAL_ACTIONS.includes(action))throw new RuleError('Unknown combat action.');
    if(values.outside&&location)throw new RuleError('You cannot aim outside your vision cone.');
    const w=['punch','kick','pushKick','grapple','pin','choke','throw','takeWeapon','escape'].includes(action)?unarmed(actor,action):weapon;
    if(w.id!=='unarmed'&&!item.system.equipped)throw new RuleError('Equip this weapon first.');
    if(w.reliability<=0&&!w.properties?.natural)throw new RuleError('This weapon is broken.');
    validateHands(actor,w);
    if(['pin','choke','throw'].includes(action)&&actor.system.combat.grappling!==target.uuid)throw new RuleError('You must grapple this target first.');
    if(action==='escape'&&actor.system.combat.grappledBy!==target.uuid)throw new RuleError('Target the actor grappling you.');
    const currentContinue=continuing&&actor.system.combat.remaining>0;
    if(currentContinue&&(style!==actor.system.combat.style||action!=='normal'))throw new RuleError('Finish the remaining strikes in this action before changing style.');
    const profile=strikeProfile(w,{style,action,npc:minor,underwater:actor.system.environment.underwater});
    const plan=currentContinue?{changes:{},modifier:actor.system.combat.extraPenalty,cost:0}:actionPlan(actor,{extra:values.extra,full:action==='charge',recovery:action==='escape'});
    const changes={...plan.changes};
    const luck=Number(values.luck);if(!Number.isInteger(luck)||luck<0||luck>actor.system.luck.value)throw new RuleError('Invalid Luck expenditure.');
    const situational=combatModifier(actor,{melee:!RANGED.includes(w.category)});
    let modifier=Number(values.modifier)+luck+profile.modifier+plan.modifier+Number(w.accuracy??0)+situational.modifier;
    const reasons=[...situational.reasons,`accuracy ${w.accuracy??0}`,`style ${profile.modifier}`,`extra action ${plan.modifier}`,`situational ${values.modifier}`,`Luck ${luck}`];
    if(location){modifier+=locate(table,location).aim;reasons.push(`aim ${locate(table,location).aim}`);}
    if(values.outside)modifier-=3;if(values.rear)modifier+=3;if(values.ambush)modifier+=5;
    if(has(target,'activelyDodging')&&!RANGED.includes(w.category))modifier-=2;
    if(action==='takeWeapon')modifier-=3;
    let range=null;
    if(RANGED.includes(w.category)){
      const rangeValue=(w.rangeBodyMultiplier?w.rangeBodyMultiplier*actor.system.derived.stats.body:w.range)/(actor.system.environment.underwater?4:1);
      range=rangeBracket(Number(values.distance),rangeValue);modifier+=range.modifier+actor.system.combat.aim;
      reasons.push(`${range.name} ${range.modifier}`,`aiming ${actor.system.combat.aim}`);
      if(actor.system.environment.underwater&&w.category==='thrown'&&!/spear/i.test(w.name))throw new RuleError('Only spears can be thrown underwater (p.165).');
    }else if(distance!==undefined&&distance>(w.properties?.longReach?2:2)&&action!=='charge'){
      throw new RuleError('Target is outside melee reach.');
    }
    const itemChanges=[];let ammunition=null;
    if(['bow','crossbow'].includes(w.category)){
      const ammo=actor.items.get(item.system.ammoId);
      if(!ammo?.system.isAmmo||ammo.system.quantity<1)throw new RuleError('Select ammunition with at least one remaining unit on the weapon sheet.');
      if(w.category==='crossbow'&&!item.system.loaded)throw new RuleError('Reload the crossbow first (one action).');
      ammunition=itemSnapshot(ammo);itemChanges.push({_id:ammo.id,'system.quantity':ammo.system.quantity-1});
      if(w.category==='crossbow')itemChanges.push({_id:item.id,'system.loaded':false});
    }else if(w.category==='thrown'||w.consumable){
      if(item.system.quantity<1)throw new RuleError('No items remain to throw.');
      itemChanges.push({_id:item.id,'system.quantity':item.system.quantity-1});
    }
    const skill=action==='feint'?'deceit':action==='escape'?'dodge':w.skill;
    const result=await check(actor.skillBase(skill,{stat:action==='feint'?'emp':action==='escape'?'ref':w.stat,modifier}).total);
    changes['system.luck.value']=actor.system.luck.value-luck;
    changes['system.combat.remaining']=currentContinue?actor.system.combat.remaining-1:profile.attacks-1;
    changes['system.combat.weaponId']=w.id;changes['system.combat.style']=style;changes['system.combat.extraPenalty']=plan.modifier;changes['system.combat.aim']=0;
    const packet={kind:'attack',actorUuid:actor.uuid,targetUuid:target.uuid,weapon:w,ammunition,action,style,aimed:location,type:values.type,cover:Number(values.cover),multiplier:profile.multiplier,meleeBonus:actor.system.derived.meleeBonus,range,underwater:actor.system.environment.underwater,check:snapshotRoll(result),resolved:false};
    await commitActor(actor,changes,itemChanges);
    const fumbleKind=w.id==='unarmed'?'unarmed':RANGED.includes(w.category)?'ranged':'melee';
    return chat(actor,`${w.name} → ${target.name}`,checkHTML(result)+`<p>${e(reasons.join('; '))}</p>`+(result.fumble?`<p><strong>Fumble:</strong> ${e(fumbleText(fumbleKind,result.fumble))}</p>`:'')+`<button type="button" data-witcher-action="defend">Defend / resolve</button>`,{rolls:result.rolls,flags:packet});
  });
}

export async function defend(message){
  const attackData=message.getFlag(SYSTEM_ID,'kind')==='attack'?message.flags[SYSTEM_ID]:null;
  if(!attackData||attackData.resolved)throw new RuleError('This attack has already been resolved.');
  const actor=owner(await actorFromUuid(attackData.targetUuid));
  const equipment=actor.items.filter(i=>i.system.equipped&&['weapon','shield'].includes(i.type)&&i.system.reliability>0);
  const options={dodge:'Dodge / Escape',reposition:'Reposition (Athletics)',blockWeapon:'Block with weapon',blockShield:'Block with shield',blockArm:'Block with arm',parry:'Parry',passive:'Passive DC (stunned / inanimate target)'};
  if(attackData.action==='feint')Object.assign(options,{awareness:'Recognize feint (Awareness)'});
  if(attackData.action==='escape')Object.assign(options,{grapple:'Maintain grapple (Brawling)'});
  const values=await prompt(`${actor.name}: defense`,input('defense','Defense',{value:attackData.action==='feint'?'awareness':attackData.action==='escape'?'grapple':has(actor,'stunned')||has(actor,'unconscious')?'passive':'dodge',options})+
    input('weapon','Weapon / shield',{options:{'':'None',...Object.fromEntries(equipment.map(i=>[i.id,i.name]))}})+
    input('arm','Blocking arm',{options:Object.fromEntries(hitLocations(actorSnapshot(actor)).filter(l=>/arm|limb/i.test(l.id)).map(l=>[l.id,l.label]))})+
    input('modifier','Situational defense modifier',{value:0})+input('gang','Assailants within melee reach',{value:1,min:1})+
    input('dc','Passive DC',{value:has(actor,'stunned')||has(actor,'unconscious')?10:attackData.range?.dc??10,min:0})+
    input('luck','Luck spent',{value:0,min:0,max:actor.system.luck.value}));
  if(!values)return;
  return serial(actor.uuid,async()=>{
    const defense=values.defense,passive=defense==='passive';
    if(!Object.hasOwn(options,defense))throw new RuleError('Invalid defense.');
    if(!passive&&has(actor,'stunned'))throw new RuleError('A stunned actor is defended at DC 10.');
    const w=actor.items.get(values.weapon);
    const armed=['blockWeapon','blockShield','parry'].includes(defense);
    if(armed&&(!w?.system.equipped||w.system.reliability<=0))throw new RuleError('Select an equipped, usable weapon or shield.');
    if(defense==='blockShield'&&w?.type!=='shield')throw new RuleError('Select a shield.');
    if(defense==='blockWeapon'&&w?.type!=='weapon')throw new RuleError('Select a weapon.');
    if(defense==='blockArm'&&RANGED.includes(attackData.weapon.category))throw new RuleError('Only a shield can block ranged attacks.');
    if(attackData.action==='feint'&&defense!=='awareness')throw new RuleError('A feint is opposed by Awareness.');
    if(attackData.action==='escape'&&defense!=='grapple')throw new RuleError('Escape is opposed by Brawling.');
    if(['grapple','pin','choke','throw','takeWeapon'].includes(attackData.action)&&!['dodge','passive'].includes(defense))throw new RuleError('Use Dodge / Escape against wrestling.');
    const plan=passive||['awareness','grapple'].includes(defense)?{changes:{},modifier:0}:actionPlan(actor,{defense:true});
    let modifier=Number(values.modifier)-Math.max(0,Number(values.gang)-1)+defenseModifier(defense,attackData.weapon.category);
    if(defense==='parry'&&w?.system.properties.parrying)modifier+=3;
    const skill=defense==='awareness'?'awareness':defense==='grapple'||defense==='blockArm'?'brawling':defense==='reposition'?'athletics':defense==='dodge'?(actor.system.environment.underwater?'athletics':'dodge'):w?.type==='shield'?'melee':w?.system.skill;
    modifier+=combatModifier(actor,{defense:true,melee:armed}).modifier;
    if(actor.system.environment.swamp&&['dodge','athletics'].includes(skill))modifier-=2;
    if(armed)modifier+=w.system.accuracy;
    const luck=Number(values.luck);if(!Number.isInteger(luck)||luck<0||luck>actor.system.luck.value)throw new RuleError('Invalid Luck expenditure.');
    if(passive&&luck)throw new RuleError('Luck cannot change a passive DC.');
    const result=passive?{total:Number(values.dc),rolls:[],base:Number(values.dc),dice:[],fumble:0}:await check(actor.skillBase(skill,{modifier:modifier+luck}).total);
    await commitActor(actor,{...plan.changes,'system.luck.value':actor.system.luck.value-luck});
    const attackRef=message.uuid;
    return chat(actor,`Defense against ${attackData.weapon.name}`,checkHTML(result)+`<p>${e(titleCase(defense))}</p>`+(defense==='reposition'?`<p>On success you may move ${actor.system.environment.underwater?actor.system.derived.leap/2:actor.system.derived.stats.spd/2} m to an unblocked space.</p>`:'')+(result.fumble?`<p>${e(fumbleText(armed?'armedDefense':'unarmed',result.fumble))}</p>`:'')+`<button type="button" data-witcher-action="resolve">Resolve (GM)</button>`,{rolls:result.rolls,flags:{kind:'defense',attackRef,actorUuid:actor.uuid,defense,weaponId:w?.id??'',arm:values.arm,check:snapshotRoll(result)}});
  });
}

export async function resolveDefense(message){
  if(!game.user.isGM)throw new RuleError('The GM resolves attacks against actors owned by other users.');
  return serial('gm-resolve',async()=>{
    const defense=message.flags[SYSTEM_ID];
    if(defense?.kind!=='defense')throw new RuleError('Not a defense result.');
    const attackMessage=await foundry.utils.fromUuid(defense.attackRef);
    const a=attackMessage?.flags[SYSTEM_ID];
    if(!a||a.resolved)throw new RuleError('This attack has already been resolved.');
    const attacker=await actorFromUuid(a.actorUuid),target=await actorFromUuid(a.targetUuid);
    if(!attacker||!target||target.uuid!==defense.actorUuid)throw new RuleError('The actors no longer match this attack.');
    if(!attacker.testUserPermission(attackMessage.author,'OWNER')||!target.testUserPermission(message.author,'OWNER'))throw new RuleError('The roll author does not own the corresponding actor.');
    const hit=beats(a.check.total,defense.check.total);
    if(!hit&&defense.defense!=='blockArm'){
      const w=target.items.get(defense.weaponId);
      if(['blockWeapon','blockShield'].includes(defense.defense)&&w)await w.update({'system.reliability':Math.max(0,w.system.reliability-1)});
      if(defense.defense==='parry')await attacker.setCondition('staggered');
      await attackMessage.update({[`flags.${SYSTEM_ID}.resolved`]:true});
      await chat(target,'Attack defended',`<p>${a.check.total} ≤ ${defense.check.total}. ${e(target.name)} avoids the hit.</p>`);
      return;
    }
    if(NO_DAMAGE.includes(a.action)){
      await resolveSpecial(attacker,target,a,defense);
      await attackMessage.update({[`flags.${SYSTEM_ID}.resolved`]:true});
      return;
    }
    const damage=await prepareDamage(attacker,target,a,defense);
    const result=await chat(attacker,`${a.weapon.name}: damage to ${target.name}`,damageHTML(damage)+`<button type="button" data-witcher-action="apply">Apply damage (GM)</button>`,{rolls:damage.rolls,flags:{kind:'damage',attackRef:attackMessage.uuid,actorUuid:attacker.uuid,targetUuid:target.uuid,request:damage.request,wound:damage.wound,conditions:damage.conditions,stun:damage.stun,summary:damage.results,state:damage.state,applied:false}});
    await attackMessage.update({[`flags.${SYSTEM_ID}.resolved`]:true,[`flags.${SYSTEM_ID}.damageRef`]:result.uuid});
    return result;
  });
}

async function resolveSpecial(attacker,target,a,defense){
  const rolls=[];let text='';
  if(a.action==='trip'){await target.setCondition('prone');text='Target is prone.';}
  if(a.action==='grapple'){
    await target.update({'system.combat.grappledBy':attacker.uuid,'system.conditions':[...new Set([...target.system.conditions,'grappled'])]});
    await attacker.update({'system.combat.grappling':target.uuid});text='Target is grappled: physical actions −2; cannot move away.';
  }
  if(a.action==='pin'){await target.setCondition('pinned');text='Target is pinned until a successful escape.';}
  if(a.action==='choke'){await target.setCondition('suffocating');text='Target is suffocating until a successful escape.';}
  if(a.action==='escape'){
    await attacker.update({'system.combat.grappledBy':'','system.conditions':attacker.system.conditions.filter(c=>!['grappled','pinned','suffocating'].includes(c))});
    await target.update({'system.combat.grappling':''});text='The grapple is broken.';
  }
  if(a.action==='feint'){
    await attacker.update({'system.combat.remaining':1,'system.combat.extraPenalty':3,'system.combat.weaponId':a.weapon.id,'system.combat.style':'fast'});text='The second fast strike gains +3.';
  }
  if(['disarm','takeWeapon'].includes(a.action)){
    const held=target.items.filter(i=>i.system.equipped&&['weapon','shield'].includes(i.type));
    if(!held.length)throw new RuleError('The defender is not holding a weapon.');
    const choice=held.length===1?{weapon:held[0].id}:await prompt('Disarm',input('weapon','Target weapon',{options:Object.fromEntries(held.map(i=>[i.id,i.name]))}),{button:'Disarm'});
    if(!choice)throw new RuleError('Disarm resolution cancelled. The attack is still pending.');
    const weapon=target.items.get(choice.weapon);
    if(a.action==='takeWeapon'){
      const used=attacker.items.filter(i=>i.system.equipped&&['weapon','shield'].includes(i.type)).reduce((n,i)=>n+i.system.hands,0);
      if(used>=2)throw new RuleError('Taking a weapon requires a free hand.');
      const data=weapon.toObject();delete data._id;data.system.equipped=true;
      const [created]=await attacker.createEmbeddedDocuments('Item',[data]);
      try{await weapon.delete();}catch(error){await created.delete();throw error;}
      text=`${attacker.name} takes ${weapon.name}.`;
    }else{
      const distance=await dice('1d6'),direction=await dice('1d10');rolls.push(distance,direction);
      await weapon.update({'system.equipped':false,'system.carried':false});text=`${weapon.name} falls ${distance.total/(a.weapon.id==='unarmed'?2:1)} m away; scatter roll ${direction.total} (p.154).`;
    }
  }
  await chat(attacker,titleCase(a.action),`<p>${e(text)}</p>`,{rolls});
}

export async function prepareDamage(attacker,target,a,defense={}){
  const state=actorSnapshot(target),table=hitLocations(state),rolls=[];
  const w=a.weapon,ammo=a.ammunition;
  const properties={...w.properties,...Object.fromEntries(Object.entries(ammo?.properties??{}).filter(([,v])=>v!==false&&v!==0&&v!==''))};
  let wound=null,bonus=0,location;
  const severity=criticalSeverity(a.check.total-(defense.check?.total??a.check.total));
  if(severity&&!NO_DAMAGE.includes(a.action)&&!properties.allLocations){
    const cr=await dice('2d6'),greater=await dice('1d6'),side=await dice('1d6');rolls.push(cr,greater,side);
    const result=criticalWound(severity.level,table,{roll:cr.total,aimed:a.aimed,greater:greater.total,side:side.total,balanced:properties.balanced?(a.aimed?1:properties.balancedBonus||2):0,organless:target.system.organless});
    wound=result.wound;bonus=result.bonus;location=result.location;
    if(wound?.stunEveryFormula){const r=await dice(wound.stunEveryFormula);rolls.push(r);wound.stunEvery=r.total;}
    if(wound?.extraRoll){const r=await dice(wound.extraRoll);rolls.push(r);wound.notes=`Additional roll: ${r.total}`;}
  }else if(a.aimed)location=locate(table,a.aimed);
  else {const r=await dice('1d10');rolls.push(r);location=locate(table,r.total);}
  if(['pushKick','throw'].includes(a.action))location=locate(table,'torso');
  if(defense.defense==='blockArm')location=locate(table,defense.arm);
  const chosen=properties.allLocations?table:[location];
  const requests=[],results=[];const conditions=[];
  if(a.action==='throw')conditions.push('prone');
  for(const loc of chosen){
    const roll=await dice(w.damage||'0');rolls.push(roll);
    let raw=Math.max(0,roll.total+(w.id==='unarmed'||RANGED.includes(w.category)||w.category==='trap'?0:a.meleeBonus));
    if(a.underwater&&['bow','crossbow'].includes(w.category))raw/=2;
    let silver=0;if(properties.silverDamage){const r=await dice(properties.silverDamage);rolls.push(r);silver=r.total;}
    if(properties.ablating){const r=await dice('1d6');rolls.push(r);properties.ablation=Math.floor(r.total/2);}
    const request={raw,silver,type:a.type,properties:{...properties},multiplier:a.multiplier??1,nonlethal:properties.nonlethal||a.action==='pommel',cover:a.cover??0,criticalBonus:chosen.length===1?bonus:0,location:loc.id};
    if(loc.id==='head'&&target.system.derived.mods.headMultiplier)loc.multiplier=target.system.derived.mods.headMultiplier;
    const result=resolveDamage(request,state,loc,state.items);
    requests.push(request);results.push(result);
  }
  if(results.some(r=>r.penetrated)||w.damage==='0'){
    for(const [property,condition] of [['bleeding','bleeding'],['poison','poison'],['fire','fire'],['freeze','frozen'],['stagger','staggered']])if(properties[property]){const r=await dice('1d100');rolls.push(r);if(r.total<=properties[property])conditions.push(condition);}
  }
  return {request:requests,results,rolls,wound,conditions,stun:severity?0:properties.stunWeapon?properties.stun:a.action==='throw'?-1:null,state:damageState(target)};
}

export function damageState(actor){return JSON.stringify({hp:actor.system.hp.value,sta:actor.system.sta.value,conditions:actor.system.conditions,locations:actor.system.locations,items:actor.items.filter(i=>['armor','wound'].includes(i.type)).map(i=>[i.id,i.system.toObject()]),race:actor.system.race,resistances:actor.system.resistances,naturalResistances:actor.system.naturalResistances,immunities:actor.system.immunities,vulnerabilities:actor.system.vulnerabilities,silverVulnerable:actor.system.silverVulnerable,meteoriteVulnerable:actor.system.meteoriteVulnerable});}
function damageHTML(damage){return `<table><thead><tr><th>Location</th><th>Rolled</th><th>Cover</th><th>SP</th><th>After armor</th><th>× location</th><th>Critical</th><th>Damage</th></tr></thead><tbody>${damage.results.map(r=>`<tr><td>${e(r.location.label)}</td><td>${r.rolled}</td><td>${r.cover}</td><td>${r.sp}</td><td>${r.resisted}</td><td>${r.location.multiplier}</td><td>${r.criticalBonus}</td><td><strong>${r.damage} ${r.nonlethal?'STA':'HP'}</strong></td></tr>`).join('')}</tbody></table>${damage.wound?`<p>Critical wound: <strong>${e(damage.wound.name)}</strong></p>`:''}${damage.conditions?.length?`<p>${e(damage.conditions.join(', '))}</p>`:''}`;}

export async function applyDamage(message){
  if(!game.user.isGM)throw new RuleError('The GM applies damage.');
  return serial('gm-damage',async()=>{
    const data=message.flags[SYSTEM_ID];
    if(data?.kind!=='damage')throw new RuleError('Not a damage result.');
    const target=await actorFromUuid(data.targetUuid);
    if(!target)throw new RuleError('Target no longer exists.');
    if(data.applied||target.system.combat.applied.includes(message.id))throw new RuleError('This damage has already been applied.');
    if(damageState(target)!==data.state){
      const state=actorSnapshot(target);
      const results=data.request.map(r=>resolveDamage(r,state,locate(hitLocations(state),r.location),state.items));
      await message.update({[`flags.${SYSTEM_ID}.state`]:damageState(target),[`flags.${SYSTEM_ID}.summary`]:results,content:`<article class="witcher-chat"><h3>Damage recalculated: ${e(target.name)}</h3>${damageHTML({...data,results})}<p>Armor or resources changed. Review the updated calculation.</p><button type="button" data-witcher-action="apply">Apply damage (GM)</button></article>`});
      return;
    }
    const changes=planDamageChanges(target,data.summary,data.conditions??[]);
    changes.actor['system.combat.applied']=[...target.system.combat.applied.slice(-199),message.id];
    const created=[];
    try{
      if(data.wound){
        created.push(...await target.createEmbeddedDocuments('Item',[{name:data.wound.name,type:'wound',system:{wound:data.wound,source:'The Witcher Core Rulebook v1.35',page:{simple:158,complex:159,difficult:159,deadly:160}[data.wound.severity]}}]));
        if(data.wound.fatal)changes.actor['system.conditions'].push('dead');
        for(const key of ['bleeding','poison','suffocating'])if(data.wound[key]&&!changes.actor['system.conditions'].includes(key))changes.actor['system.conditions'].push(key);
        if(data.wound.deathSave)changes.actor['system.pendingDeathSaves']=(changes.actor['system.pendingDeathSaves']??target.system.pendingDeathSaves)+1;
      }
      await commitActor(target,changes.actor,changes.items);
    }catch(error){if(created.length)await target.deleteEmbeddedDocuments('Item',created.map(i=>i.id));throw error;}
    await message.update({[`flags.${SYSTEM_ID}.applied`]:true,content:message.content.replace(/<button\b[^>]*data-witcher-action="apply"[^>]*>[\s\S]*?<\/button>/g,'<p><strong>Damage applied.</strong></p>')});
    if(data.stun!==null&&data.stun!==undefined&&!has(target,'dead'))await save(target,'stun',{modifier:data.stun});
    if(target.system.pendingDeathSaves&&!has(target,'dead'))await chat(target,'Death save required',`<p>${target.system.pendingDeathSaves} save(s) pending. Choose Luck before rolling.</p><button type="button" data-witcher-action="death">Death save</button>`,{flags:{actorUuid:target.uuid}});
  });
}

export function planDamageChanges(actor,results,addConditions=[]){
  const conditions=new Set([...actor.system.conditions,...addConditions]);conditions.delete('stunned');
  let hp=actor.system.hp.value,sta=actor.system.sta.value;
  const locations=foundry.utils.deepClone(actor.system.locations),items=new Map();
  for(const result of results){
    if(result.nonlethal)sta-=result.damage;else hp-=result.damage;
    for(const change of result.armorChanges){
      const update=items.get(change.id)??{_id:change.id};update[`system.sp.${change.location}`]=change.after;items.set(change.id,update);
    }
    const loc=locations.find(l=>l.id===result.naturalChange.location);if(loc)loc.sp=result.naturalChange.after;
  }
  const changes={'system.hp.value':hp,'system.sta.value':sta,'system.locations':locations};
  if(sta<=0){conditions.add('stunned');conditions.add('unconscious');changes['system.unconsciousRecovery']=0;}
  if(hp<=0&&results.some(r=>!r.nonlethal&&r.damage>0))changes['system.pendingDeathSaves']=actor.system.pendingDeathSaves+1;
  if(actor.system.conditions.includes('unconscious'))conditions.add('stunned');
  changes['system.conditions']=[...conditions];
  return {actor:changes,items:[...items.values()]};
}

export function registerCombatChat(){
  Hooks.on('renderChatMessageHTML',(message,html)=>{
    html.querySelectorAll('[data-witcher-action]').forEach(button=>button.addEventListener('click',async event=>{
      event.preventDefault();button.disabled=true;
      try{
        const action=button.dataset.witcherAction;
        if(action==='defend')await defend(message);
        if(action==='resolve')await resolveDefense(message);
        if(action==='apply')await applyDamage(message);
        if(action==='death'){
          const actor=owner(await actorFromUuid(message.flags[SYSTEM_ID].actorUuid));
          const values=await prompt('Death save',input('luck','Luck spent',{value:0,min:0,max:actor.system.luck.value}));
          if(values)await save(actor,'death',{luck:Number(values.luck)});
        }
      }catch(error){errorNotice(error);}finally{button.disabled=false;}
    }));
  });
  Hooks.on('createChatMessage',message=>{
    if(isPrimaryActiveGm()&&message.getFlag(SYSTEM_ID,'kind')==='defense')resolveDefense(message).catch(errorNotice);
  });
}
