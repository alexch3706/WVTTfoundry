import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WOUNDS,criticalWound,combinedModifiers,fumbleText} from '../../module/witcher/wounds.js';
import {HUMANOID_LOCATIONS,MONSTER_LOCATIONS} from '../../module/witcher/config.js';
import {allocateMaterials,craftingRecovery,repairDifficulty} from '../../module/witcher/crafting.js';
import {derivedStats,resolveDamage} from '../../module/witcher/rules.js';

test('p.158–160: all 24 wounds and every 2d6 result resolve',()=>{
  assert.equal(Object.values(WOUNDS).flat().length,24);
  for(const severity of Object.keys(WOUNDS))for(let roll=2;roll<=12;roll++){
    const result=criticalWound(severity,HUMANOID_LOCATIONS,{roll,side:1});
    assert.equal(result.wound.severity,severity);assert.ok(result.location.id);
  }
});
test('p.158: aimed head/torso criticals use 1–4 lesser, 5–6 greater',()=>{
  assert.equal(criticalWound('simple',HUMANOID_LOCATIONS,{aimed:'head',greater:4}).wound.name,'Disfiguring Scar');
  assert.equal(criticalWound('simple',HUMANOID_LOCATIONS,{aimed:'head',greater:5}).wound.name,'Cracked Jaw');
  assert.equal(criticalWound('deadly',HUMANOID_LOCATIONS,{aimed:'torso',greater:4}).wound.name,'Septic Shock');
  assert.equal(criticalWound('deadly',HUMANOID_LOCATIONS,{aimed:'torso',greater:5}).wound.name,'Heart Damage');
  assert.equal(criticalWound('deadly',HUMANOID_LOCATIONS,{aimed:'head',greater:4,balanced:1}).wound.fatal,true);
});
test('p.159: organless monsters replace specified wounds with their bonus damage',()=>{
  const result=criticalWound('difficult',MONSTER_LOCATIONS,{roll:8,organless:true});
  assert.equal(result.wound,null);assert.equal(result.bonus,15);assert.equal(result.location.id,'torso');
  assert.equal(criticalWound('difficult',MONSTER_LOCATIONS,{roll:11,organless:true}).wound.name,'Concussion');
});
test('p.159: an absent anatomical location requires a reroll, not a nonexistent leg',()=>{
  const specter=[{...MONSTER_LOCATIONS[0]},{...MONSTER_LOCATIONS[1],max:10}];
  assert.throws(()=>criticalWound('simple',specter,{roll:2}),/no leg/);
});
test('p.158: rib injury changes BODY without reducing maximum HP',()=>{
  const actor={stats:{body:8,will:6},hp:{value:35},statModifiers:{}};
  const items=[{type:'wound',wound:{...WOUNDS.simple[3],treatment:'untreated'}}];
  const d=derivedStats(actor,items);
  assert.equal(d.stats.body,6);assert.equal(d.hpMax,35);
  items[0].wound.treatment='treated';
  assert.equal(derivedStats(actor,items).stats.body,8);assert.equal(derivedStats(actor,items).enc,70);
});
test('p.158: foreign object recovery progresses from quarter to half to −2',()=>{
  const w={...WOUNDS.simple[2],treatment:'untreated'};
  const actor={stats:{body:8,will:8},hp:{value:40}};
  assert.equal(derivedStats(actor,[{type:'wound',wound:w}]).rec,2);
  w.treatment='stabilized';assert.equal(derivedStats(actor,[{type:'wound',wound:w}]).rec,4);
  w.treatment='treated';assert.equal(derivedStats(actor,[{type:'wound',wound:w}]).rec,6);
});
test('p.23: dwarf SP does not ablate and their encumbrance increases by 25',()=>{
  const location={...HUMANOID_LOCATIONS[1]};
  const damage=resolveDamage({raw:10},{race:'dwarf'},location);
  assert.equal(damage.damage,8);assert.equal(damage.naturalChange.after,0);
  assert.equal(derivedStats({race:'dwarf',stats:{body:5},hp:{value:25}}).enc,75);
});
test('p.162: meteorite exemption belongs to the specific monster',()=>{
  const location=HUMANOID_LOCATIONS[1];
  assert.equal(resolveDamage({raw:10,properties:{meteorite:true}},{silverVulnerable:true},location).damage,5);
  assert.equal(resolveDamage({raw:10,properties:{meteorite:true}},{silverVulnerable:true,meteoriteVulnerable:true},location).damage,10);
});
test('p.127: materials cannot be reused across repeated requirements',()=>{
  const materials=[{name:'Iron',quantity:2},{name:'Iron',quantity:2}];
  assert.throws(()=>allocateMaterials(materials,[{id:'a',name:'Iron',quantity:3}]),/Missing 1/);
  assert.deepEqual(allocateMaterials(materials,[{id:'a',name:'Iron',quantity:5}]).map(x=>[x.quantity,x.after]),[[4,1]]);
});
test('p.142: alchemy can substitute ingredients containing the same substance',()=>{
  const result=allocateMaterials([{name:'Vitriol',substance:'Vitriol',quantity:3}],[{id:'a',name:'Barley',substance:'Vitriol',quantity:1},{id:'b',name:'Crow’s Eye',substance:'Vitriol',quantity:5}]);
  assert.deepEqual(result.map(i=>[i.id,i.quantity,i.after]),[['a',1,0],['b',2,3]]);
  assert.throws(()=>allocateMaterials([{name:'Iron',quantity:1}],[{id:'x',name:'Dark Iron',quantity:5}]),/Missing/);
});
test('p.127,142: crafting recovers half rounding up, alchemy exactly one chosen substance',()=>{
  const used=[{id:'a',quantity:3,substance:'Vitriol'},{id:'b',quantity:2,substance:'Rebis'}];
  assert.deepEqual(craftingRecovery(used,{success:true}),[{id:'a',quantity:2},{id:'b',quantity:1}]);
  assert.deepEqual(craftingRecovery(used,{success:true,alchemy:true}),[{name:'Vitriol',quantity:1},{name:'Rebis',quantity:1}]);
  assert.deepEqual(craftingRecovery(used,{success:false}),[]);
  assert.equal(repairDifficulty({craftDC:18},2),17);
});
test('p.157: severe fumbles retain distinct armed/unarmed/ranged consequences',()=>{
  assert.match(fumbleText('melee',8),/1d10 reliability/);
  assert.match(fumbleText('armedDefense',8),/Prone/);
  assert.match(fumbleText('ranged',8),/jammed/);
  assert.match(fumbleText('unarmed',9),/nonlethal/);
  assert.match(fumbleText('unarmed',10),/lethal damage/);
});
