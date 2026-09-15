/** Validate against genuine V14 field/DataModel implementations supplied locally.
 * This loads only the public client bundle's data layer, not a Foundry server.
 * It is deliberately a separate check from live sheet/multiplayer acceptance.
 * Usage: node tools/witcher/validate-core-models.mjs /path/to/foundry.mjs
 */
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const bundle=await fs.readFile(process.argv[2],'utf8');
const start=bundle.indexOf('\n')+1;
const end=bundle.indexOf('/**\n * @import ActiveEffect from "../documents/active-effect.mjs";');
assert(end>start,'Recognizable V14 data-layer boundary');
const expose=`
globalThis.foundry={abstract:{TypeDataModel,DataModel},data:{fields:{NumberField,StringField,BooleanField,ArrayField,SchemaField,TypedObjectField,HTMLField,ObjectField}},utils:{deepClone,expandObject,flattenObject,getProperty,mergeObject,isDeletionKey}};
globalThis.Actor=Document;globalThis.Item=Document;
`;
vm.runInThisContext(bundle.slice(start,end)+expose,{filename:'foundry-v14-public-data-layer.mjs'});
const {WitcherActorData,WitcherMonsterData,WitcherItemData}=await import('../../module/witcher/documents.js');
const {HUMANOID_LOCATIONS,MONSTER_LOCATIONS}=await import('../../module/witcher/config.js');
const actor=new WitcherActorData({locations:HUMANOID_LOCATIONS},{strict:true});
assert.equal(actor.stats.ref,5);assert.equal(actor.hp.value,25);
assert.equal(new WitcherMonsterData({locations:MONSTER_LOCATIONS},{strict:true}).anatomy,'monster');
const manifest=JSON.parse(await fs.readFile(new URL('../../system.json',import.meta.url),'utf8'));
let count=0;
for(const pack of manifest.packs){
  const rows=JSON.parse(await fs.readFile(new URL(`../../data/witcher/${pack.name}.json`,import.meta.url),'utf8'));
  for(const row of rows){
    try{
      const model=new WitcherItemData(row.system,{strict:true});
      assert.equal(model.quantity,row.system.quantity);
      for(const key of Object.keys(row.system))assert(Object.hasOwn(WitcherItemData.schema.fields,key),`${row.name}: undeclared field ${key}`);
      count++;
    }catch(error){throw new Error(`${pack.name}/${row.name}: ${error.message}`,{cause:error});}
  }
}
console.log(`Genuine V14 data layer: actor defaults and ${count} item records validated.`);
