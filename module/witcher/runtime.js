import {SYSTEM_ID} from './config.js';
import {resolveCheck,RuleError,reserveAction} from './rules.js';
import {resolveFoundryUuid} from '../foundry-compat.js';

export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const owner=actor=>{if(!actor?.isOwner)throw new RuleError('You must own this actor.');return actor;};
export const actorFromUuid=async uuid=>{const doc=await resolveFoundryUuid(uuid);return doc?.documentName==='Token'?doc.actor:doc;};
export const errorNotice=error=>{console.error(`${SYSTEM_ID} |`,error);ui.notifications.error(error.message);};
const queues=new Map();
export function serial(key,operation){
  const task=(queues.get(key)??Promise.resolve()).catch(()=>{}).then(operation);
  queues.set(key,task);
  task.finally(()=>{if(queues.get(key)===task)queues.delete(key);}).catch(()=>{});
  return task;
}

/** Await each persistence operation and restore the exact changed fields on failure. */
export async function commitActor(actor,changes={},itemChanges=[]){
  const before=Object.fromEntries(Object.keys(changes).map(k=>[k,foundry.utils.deepClone(foundry.utils.getProperty(actor._source,k))]));
  const beforeItems=itemChanges.map(change=>{
    const item=actor.items.get(change._id);
    if(!item)throw new RuleError('Equipment changed while this action was pending.');
    return {_id:item.id,...Object.fromEntries(Object.keys(change).filter(k=>k!=='_id').map(k=>[k,foundry.utils.deepClone(foundry.utils.getProperty(item._source,k))]))};
  });
  let actorWritten=false;
  try{
    if(Object.keys(changes).length){await actor.update(changes);actorWritten=true;}
    if(itemChanges.length)await actor.updateEmbeddedDocuments('Item',itemChanges);
  }catch(error){
    const recovery=[];
    if(actorWritten)recovery.push(actor.update(before));
    // Embedded operations can partially succeed, so restore every affected field.
    if(beforeItems.length)recovery.push(actor.updateEmbeddedDocuments('Item',beforeItems));
    const outcomes=await Promise.allSettled(recovery);
    if(outcomes.some(r=>r.status==='rejected'))ui.notifications.error('Action failed and rollback was incomplete. The GM must inspect actor resources and equipment.');
    throw error;
  }
}

export function input(name,label,{value='',type='number',options,min,max,step=1,checked=false}={}){
  const e=escapeHTML;
  const element=options?`<select name="${e(name)}">${Object.entries(options).map(([key,label])=>`<option value="${e(key)}" ${String(key)===String(value)?'selected':''}>${e(label)}</option>`).join('')}</select>`:
    type==='checkbox'?`<input name="${e(name)}" type="checkbox" ${checked?'checked':''}>`:
    `<input name="${e(name)}" type="${e(type)}" value="${e(value)}" ${min!==undefined?`min="${min}"`:''} ${max!==undefined?`max="${max}"`:''} step="${step}">`;
  return `<label class="witcher-field"><span>${e(label)}</span>${element}</label>`;
}
export function prompt(title,content,{button='Roll',width=480}={}){
  return new Promise(resolve=>{
    const DialogClass=globalThis.Dialog??foundry.appv1.api.Dialog;
    new DialogClass({title,content:`<form class="witcher-dialog">${content}</form>`,buttons:{submit:{label:button,callback:html=>{
      const element=html[0]??html;const form=element.querySelector('form');
      const values=Object.fromEntries(new FormData(form));
      for(const el of form.querySelectorAll('input[type=checkbox]'))values[el.name]=el.checked;
      resolve(values);
    }},cancel:{label:'Cancel',callback:()=>resolve(null)}},default:'submit',close:()=>resolve(null)},{width}).render(true);
  });
}
export async function dice(formula){
  if(!Roll.validate(formula))throw new RuleError(`Invalid roll formula: ${formula}`);
  const roll=await new Roll(formula).evaluate();
  if(!Number.isFinite(roll.total))throw new RuleError('The dice did not produce a number.');
  return roll;
}
export async function check(base){
  const rolls=[await dice('1d10')];
  if([1,10].includes(rolls[0].total))do{rolls.push(await dice('1d10'));}while(rolls.at(-1).total===10);
  return {...resolveCheck(base,rolls.map(r=>r.total)),rolls};
}
export async function chat(actor,title,content,{rolls=[],flags={},whisper}={}){
  const data={speaker:ChatMessage.getSpeaker({actor}),content:`<article class="witcher-chat"><h3>${escapeHTML(title)}</h3>${content}</article>`,rolls,flags:{[SYSTEM_ID]:flags}};
  if(whisper)data.whisper=whisper;else ChatMessage.applyRollMode(data,game.settings.get('core','rollMode'));
  return ChatMessage.create(data);
}
export function checkHTML(result){return `<p class="witcher-total">${result.total}</p><p>Base ${result.base}; d10: ${result.dice.join(', ')}${result.fumble?'; fumble '+result.fumble:''}</p>`;}
export function actionPlan(actor,options={}){
  owner(actor);
  const conditions=actor.system.conditions;
  if(conditions.includes('dead'))throw new RuleError('A dead actor cannot act.');
  if(!options.recovery&&conditions.some(c=>['stunned','unconscious','pinned'].includes(c)))throw new RuleError('Only recovery or escape is possible in this condition.');
  const combat=game.combat;
  if(!combat?.started)return {changes:{},cost:0,modifier:options.extra?-3:0};
  if(!options.defense&&combat.combatant?.actor?.uuid!==actor.uuid)throw new RuleError('Advance the combat tracker to this actor’s turn first.');
  const roundKey=`${combat.id}:${combat.round}`;
  const turnKey=`${roundKey}:${combat.turn}`;
  const budget=foundry.utils.deepClone(actor.system.combat);
  if(budget.roundKey!==roundKey)budget.defenses=0;
  if(!options.defense&&budget.key!==turnKey){budget.actions=0;budget.extra=0;budget.remaining=0;}
  const result=reserveAction(budget,{...options,activelyDodging:conditions.includes('activelyDodging')});
  if(result.cost>actor.system.sta.value)throw new RuleError('Not enough Stamina.');
  return {...result,changes:{'system.combat.roundKey':roundKey,...(!options.defense?{'system.combat.key':turnKey}:{}),...Object.fromEntries(Object.entries(result.budget).map(([k,v])=>['system.combat.'+k,v])),'system.sta.value':actor.system.sta.value-result.cost}};
}
export async function skillRoll(actor,key,{modifier=0,stat,dialog=true,title}={}){
  owner(actor);
  let luck=0;
  if(dialog){const values=await prompt(title??key,input('modifier','Situational modifier',{value:modifier})+input('luck','Luck spent',{value:0,min:0,max:actor.system.luck.value}));if(!values)return;modifier=Number(values.modifier);luck=Number(values.luck);}
  if(!Number.isInteger(luck)||luck<0||luck>actor.system.luck.value)throw new RuleError('Invalid Luck expenditure.');
  const result=await check(actor.skillBase(key,{stat,modifier:modifier+luck}).total);
  if(luck)await actor.update({'system.luck.value':actor.system.luck.value-luck});
  await chat(actor,title??key,checkHTML(result),{rolls:result.rolls});
  return result;
}

export async function save(actor,kind,{modifier=0,luck=0}={}){
  owner(actor);
  if(!['stun','death','body'].includes(kind))throw new RuleError('Unknown save.');
  if(luck&&kind!=='death')throw new RuleError('Luck can only modify a Death save.');
  if(!Number.isInteger(luck)||luck<0||luck>actor.system.luck.value)throw new RuleError('Invalid Luck expenditure.');
  const threshold=(kind==='death'?actor.system.derived.deathTarget-actor.system.deathSaves:kind==='stun'?actor.system.derived.stun:actor.system.derived.stats.body)+modifier+luck;
  const roll=await dice('1d10');const success=roll.total<threshold;
  const conditions=new Set(actor.system.conditions);const changes={};
  if(kind==='death'){
    changes['system.deathSaves']=actor.system.deathSaves+1;
    changes['system.pendingDeathSaves']=Math.max(0,actor.system.pendingDeathSaves-1);
    changes['system.luck.value']=actor.system.luck.value-luck;
    if(!success)conditions.add('dead');
  }else if(kind==='stun'){
    if(!success)conditions.add('stunned');
    else if(!conditions.has('unconscious')||actor.system.unconsciousRecovery>=20){conditions.delete('stunned');conditions.delete('unconscious');}
  }
  changes['system.conditions']=[...conditions];await actor.update(changes);
  await chat(actor,`${kind} save`, `<p>${roll.total} &lt; ${threshold}: <strong>${success?'Success':'Failure'}</strong></p>`,{rolls:[roll]});
  return success;
}
