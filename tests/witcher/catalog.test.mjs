import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {ITEM_TYPES} from '../../module/witcher/config.js';

const manifest=JSON.parse(await fs.readFile(new URL('../../system.json',import.meta.url),'utf8'));
const packs=Object.fromEntries(await Promise.all(manifest.packs.map(async pack=>{
  const file=new URL(`../../data/witcher/${pack.name}.json`,import.meta.url);
  return [pack.name,JSON.parse(await fs.readFile(file,'utf8'))];
})));
const all=Object.values(packs).flat();
const find=name=>all.find(i=>i.name===name)?.system;

test('catalog has every extracted core equipment row and stable unique IDs',async()=>{
  const audit=JSON.parse(await fs.readFile(new URL('../../data/witcher/source-audit.json',import.meta.url),'utf8'));
  assert.equal(all.length,673);assert.equal(audit.rows.length,all.length);
  for(const [name,items] of Object.entries(packs)){
    assert.equal(new Set(items.map(i=>i._id)).size,items.length,name);
    assert.equal(items.length,audit.counts[name]);
    for(const item of items){assert.match(item._id,/^[a-z0-9]{16}$/);assert.ok(ITEM_TYPES.includes(item.type));assert.ok(item.system.page>0);assert.ok(Number.isFinite(item.system.weight));assert.ok(Number.isFinite(item.system.cost));}
  }
});
test('p.73–74: quantities, price and weight for ammunition use the same unit',()=>{
  const ammo=find('Standard Ammunition');
  assert.equal(ammo.quantity,10);assert.equal(ammo.weight*ammo.quantity,.5);assert.equal(ammo.cost*ammo.quantity,10);
  assert.equal(find('Witcher’s Silver Sword').properties.silverDamage,'3d6');
});
test('p.249: graphical potion recipes retain each ingredient symbol and quantity',()=>{
  const recipe=find('Black Blood Formula');
  assert.deepEqual(recipe.materials.map(i=>[i.name,i.quantity]),[['Vitriol',3],['Rebis',1],['Aether',1]]);
  assert.equal(recipe.craftDC,20);
  assert.deepEqual(find('Swallow Formula').materials.map(i=>i.name),['Vitriol','Aether','Caelum']);
});
test('p.250: blade oils include dog tallow; decoctions include mutagen and spirits',()=>{
  assert.ok(find('Beast Oil Formula').materials.some(i=>i.name==='Dog Tallow'&&i.quantity===1));
  const decoction=find('Arachas Formula');
  assert.ok(decoction.materials.some(i=>i.name==='Arachas Mutagen'));
  assert.ok(decoction.materials.some(i=>i.name==='Spirits'));
  assert.equal(find('Arachas Decoction').duration,600);assert.equal(find('Arachas Decoction').toxicity,75);
});
test('all diagrams link to products; the source’s Etching Oil omission remains explicit',async()=>{
  for(const recipe of packs.diagrams){assert.ok(recipe.system.productUuid,recipe.name);assert.ok(recipe.system.materials.length,recipe.name);}
  const audit=JSON.parse(await fs.readFile(new URL('../../data/witcher/source-audit.json',import.meta.url),'utf8'));
  assert.deepEqual(audit.unresolved,[{diagram:'Elven Shield Diagram',material:'Etching Oil'}]);
});
test('p.254: experimental weights and bomb range are not ordinary thrown-weapon values',()=>{
  assert.equal(find('Dancing Star').weight,1);assert.equal(find('Dancing Star').rangeBodyMultiplier,4);
  assert.equal(find('Biter').weight,2);assert.equal(find('Explosive Ammunition').weight,.1);
});
