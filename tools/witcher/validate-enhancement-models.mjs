/** Validate Shining's native light against a locally supplied genuine V14 client
 * data layer, without claiming to start a Foundry server or canvas.
 * Usage: node tools/witcher/validate-enhancement-models.mjs /path/to/foundry.mjs
 */
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const bundle = await fs.readFile(process.argv[2], 'utf8');
const boundary = bundle.indexOf('/**\n * @import ActiveEffect from "../documents/active-effect.mjs";');
const lightStart = bundle.indexOf('class LightData extends DataModel');
const lightData = bundle.slice(lightStart, bundle.indexOf('\n}', lightStart) + 2);
const native = bundle.slice(
  bundle.indexOf('class BaseAmbientLight extends Document'),
  bundle.indexOf('/**\n * @import {AmbientSoundData}')
);
const idStart = bundle.indexOf('static validateId(id) {');
const packageValidation = bundle.slice(idStart, bundle.indexOf('\n  }', idStart) + 4);
assert(
  boundary > 0 && lightStart > 0 && native.length > 0 && idStart > 0,
  'Recognizable genuine V14 model boundaries'
);
vm.runInThisContext(
  bundle.slice(bundle.indexOf('\n') + 1, boundary) +
    lightData +
    '\n' +
    native +
    `
globalThis.NativeLight=BaseAmbientLight;
globalThis.CONFIG={};
globalThis.foundry={abstract:{TypeDataModel,DataModel,Document},packages:{BasePackage:class{${packageValidation}}},data:{fields:{NumberField,StringField,BooleanField,ArrayField,SchemaField,TypedObjectField,HTMLField,ObjectField}},utils:{deepClone,expandObject,flattenObject,getProperty,mergeObject,isDeletionKey}};
globalThis.Actor=Document;globalThis.Item=Document;
`,
  { filename: 'foundry-v14-native-light-data.mjs' }
);
const { shiningLightData } = await import('../../module/witcher/enhancements-light.js');
const token = {
  id: '1234567890abcdef',
  name: 'Carrier',
  level: 'abcdef1234567890',
  parent: { grid: { size: 100, distance: 2, units: 'm' } },
  actor: { uuid: 'Actor.1234567890abcdef' },
  getCenterPoint() {
    return { x: 200, y: 300, elevation: 0 };
  },
};
const data = shiningLightData(token, '1234567890abcdef', { id: 'fedcba0987654321', expires: 1900 });
const light = new NativeLight(data, { strict: true });
const stored = light.toObject();
assert.equal(stored.config.bright, 6);
assert.equal(stored.config.attenuation, 0);
assert.equal(stored.flags['witcher-rilerena'].shining.sunlight, true);
assert.equal(stored.flags['witcher-rilerena'].shining.expires, 1900);
assert.deepEqual(stored.levels, ['abcdef1234567890']);
assert.equal(stored.walls, true);
console.log(
  'Genuine V14 AmbientLight: Shining 6m daylight, scene level, duration and source flags validated. Canvas/multiplayer acceptance remains separate.'
);
