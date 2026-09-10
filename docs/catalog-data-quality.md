# Compendium data quality

The catalog contains 2,124 documents in 28 packs, including 607 weapons and 199
armor Items. Valid Foundry V14 storage does not establish valid combat data.
The content pipeline now checks both, using the same mechanical contract as
the runtime resolver.

## Using catalog items

An Item's **Combat data review** panel shows its current status and any missing
rules or fields. Checked records contain an explicit configuration, numeric
machine fields and supported mechanics. Manual records remain in the catalog
under their original IDs, with specific reasons why automatic combat cannot
resolve them. They do not spend ammunition or update wounds, armor or saves.

After verifying and editing a record, a GM can choose **Custom / reviewed by
GM**. Mechanical validation still applies. Empty fire-mode lists mean no modes
are permitted; they do not re-enable automatic fire. Unknown AP is different
from ordinary ammunition. Unknown weight stays blank and is counted separately
on the inventory tab rather than contributing an invented kilogram.

Shotgun damage uses explicit point-blank, close, medium and far formulas. Some
weapons have a documented base stock/magazine configuration; alternatives are
retained in the source evidence. Exotic ammunition, unresolved damage/accuracy
bands, special weapon effects, anti-vehicle rules and full-body conversion
thresholds remain manual where the implemented mechanics cannot represent them.

Armor displays current/base SP **per location**. Its editor exposes SP,
ablation, soft/hard material and EV. Worn armor and protective cyberware can
affect REF; a protected object or held shield does not grant passive whole-body
armor. Armor with the documented edged-weapon vulnerability halves its current
SP before layering when struck by an explicitly edged weapon. Unknown melee
damage type requires review for that interaction; ordinary bullets and blunt
attacks retain full SP.

For legacy cyberware, the per-location editor is disabled until explicitly
configured. Saving unrelated fields must not create zero-SP coverage that
shadows older protection data.

## Updating items already in a world

Updating a system pack does not update copies already imported into Actors.
Use **Game Settings → Configure Settings → Update imported catalog items**.
Preview first, inspect the listed changes/conflicts, then apply the reviewed
updates as the primary active GM.

The preview includes world Items, Actor Items and unlinked-token Actor Items.
Only explicit references to this system's compendia are eligible. Items with
missing references are reported and left for manual reconciliation. This menu
does not unlock or edit world compendia, Adventures or package compendia.

Each definition field is compared with retained catalog baseline data. Absent
fields and unchanged old definitions can be updated. Custom changes are kept;
mechanical conflicts require review. Current ammunition, equipped state,
ablation, installed limb location, SDP and humanity loss are preserved. Weapons
are never reloaded by this process. Aliased location names and legacy armor
damage that cannot be mapped safely are reported for manual reconciliation.

The preview is checked again before writing. If an item or its catalog source
changed, refresh the preview. Updates run sequentially and are checked after
saving; partial failures are reported and rerunning the preview is safe.

The same functions are available to GM tooling:

```js
const preview = await game.cyberpunk.previewCatalogMigration();
// Inspect preview.entries, including changes and conflicts.
await game.cyberpunk.applyCatalogMigration(preview);
```

## Editing and building content

`src/compendia/<manifest-pack-name>/<id>.json` holds the canonical build inputs.
`src/compendia/manifest.json` fixes their existing IDs and document types. A
renamed item retains its ID; name hashing is no longer an identity strategy.

For repaired weapons/armor, `flags.cyberpunk2020-rilerena.catalog.sourceValues`
retains the original import. Make curated corrections in
`data/compendium-overrides/weapons.json` or `armor.json`, with source evidence,
then regenerate the machine fields. Editing a normalized `system` field alone
is not sufficient: normalization will derive it again from the retained import
and reviewed override. Unscoped catalog categories remain unchanged.

```sh
node tools/catalog.mjs normalize --write
node tools/catalog.mjs audit --write
node --test tests/*catalog*.test.mjs tests/item-contract.test.mjs
node tools/catalog.mjs build           # compile and round-trip in temporary directories
node tools/catalog.mjs build --write   # replace verified changed packs
node tools/catalog.mjs check           # compare every source document with its shipped pack
```

`bootstrap` is a one-time extraction command and refuses to overwrite existing
sources. All LevelDB extraction opens temporary copies. Pack compilation uses
the pinned official Foundry CLI, validates the V14 envelope, round-trips every
document, checks unchanged identities and detects concurrent pack changes before
replacement. A second build should report zero packs to write.

The complete pending review queue and current counts are generated in
[`catalog-audit.json`](catalog-audit.json). CI rejects a supposedly ready record
that violates its semantic contract, a manual record without a reason, changed
IDs, stale normalized sources, or a source/pack mismatch. Integration tests feed
every ready weapon and armor into the real snapshot/resolver paths and ensure
every manual weapon yields no automatic state changes.

## Sources and remaining coverage

The locally supplied *Cyberpunk 2020 Reference Book v5* (Andrew James, 2002,
134 PDF pages) supplies tabular facts and source-book codes. Its SHA-256 is
`05fb5a21b9400c7083d21e8d74a3b7374a5d180b89551b7a1da185b28fc21613`.
The PDF is stored outside the repository and is not a release asset.
Overrides record reference pages and relevant Cyberpunk Wiki links. The
reference compilation and Wiki are secondary sources; conflicts are retained
as explicit review items rather than resolved by guessing.

Only mechanical facts, existing import data and short original explanations
are tracked. Do not add the PDF, extracted book prose or copied tables to the
repository. Consult the cited sourcebook when a secondary source is ambiguous.

Full-body conversions need separate disable/destroy SDP thresholds, not a
three-location interpretation of `20/30/40`. Conditional armor coverage, certain
SP-changing implants, unusual shotgun loads and extended penetration types also
need richer mechanics before becoming automated. This change does not certify
vehicle, skill, general gear or nonprotective cyberware catalog semantics.
