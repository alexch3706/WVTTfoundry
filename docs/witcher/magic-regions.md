# Magic areas in Foundry V14

The magic placement helper uses V14's native **Regions**. It does not create a legacy `MeasuredTemplate`, spend Stamina, roll a spell, or apply damage. Those operations belong to the authoritative casting workflow.

## Rules and table decisions

- Core, printed p. 114: Aard and Igni have a 2 m cone; Yrden has a 3 m radius.
- Core, printed p. 115: Magic Trap has a 3 m radius; Aard Sweep has a 4 m **sphere**, including flying creatures.
- The sign entries do not print a cone angle. The caller must supply a visible table convention; the helper never silently invents one. Pass `angleSource: 'table'` to retain that warning in the preview.
- Yrden and Magic Trap remain at the place of casting. They do not attach to or follow the caster token.
- A ground circle tests contact with the caster's ground elevation. A sphere additionally checks three-dimensional distance against the token's actual elevation and depth. An area whose printed height is unspecified uses its scene level and displays a warning so the GM can review elevated targets.
- Native Foundry token containment determines partial coverage and boundary cases. This considers large tokens, their shapes, depth, scene levels, and restricted Region geometry. The GM can include or exclude particular scene tokens with an explicit recorded reason.
- Native wall restrictions use movement-blocking walls by default. A different rule must deliberately request another supported restriction or disable it. The authority must view the caster's scene and level: V14 only computes Region wall constraints for a viewed level. The helper reports this requirement instead of accepting an unchecked area.

Dimensions come from the scene's actual scale. For a 100 px grid with 2 m squares, a 3 m radius becomes 150 px. Scenes measured in other units require an explicit `metresPerUnit` conversion. Empty or unknown units are rejected.

## Integration API

```js
const spec = {
  shape: 'cone', // 'circle', 'cone', or 'line'; 'ray' is accepted as an alias for line
  distance: 2, // metres; circles use radius, lines also require width
  angle: configuredConeAngle,
  angleSource: 'table',
  origin: 'caster', // 'ranged' additionally requires a range in metres
  volume: 'level', // 'ground', 'sphere', or explicitly unspecified height on this level
  includeCaster: false,
  wallRestriction: 'move', // 'sight' or false are deliberate alternatives
};
const preview = await previewMagicRegion({ casterToken, spec, name: spell.name });
if (!preview) return; // Cancellation: no documents or resources were changed.
```

The native call is `canvas.regions.placeRegion(data, {create: false, ...})`. Its returned document is local and unpersisted. Pointer movement rotates anchored cones and lines without moving their origin. Native left-click confirmation, right-click skip, and Escape cancellation remain available.

Preview results contain `{sceneId, casterTokenId, origin, placement, targetIds, candidates, warnings}`. Hidden tokens are omitted from a player's preview. Do not trust client-supplied target IDs or geometry when resolving the spell.

Inside the existing GM authority queue, reload the caster and the spell, derive `spec` from authoritative data, and call:

```js
const area = validateMagicRegion({
  scene,
  casterToken,
  spec,
  placement: preview.placement,
  expectedOrigin: preview.origin,
  requester,
  // Optional, GM only:
  // override: {include: [tokenId], exclude: [], reason: 'Reviewed boundary coverage.'},
});
```

Validation rebuilds dimensions, reevaluates walls and every target's current containment, verifies ranged placement, and rejects a stale caster origin. It returns a fresh unpersisted `region`, its source `data`, and the actual target IDs. Target defenses and effect resolution still occur in the casting workflow; geometric inclusion does not mean a hit.

## Persistent zones

Register the custom native behavior during system initialization:

```js
registerMagicRegionBehavior(handleMagicAreaEvent, { isAuthority: isElectedGM });
```

The handler receives V14 events for entry, exit, turn start/end, and round start/end. It must enter the existing authoritative command queue. The behavior executes no supplied scripts or macros. Foundry's separate movement/animation events are deliberately not used as extra attack triggers.

After a successful cast, `createMagicRegion({scene, casterToken, spec, placement, expectedOrigin, requester, name, links, rounds, state})` revalidates the placement and creates the persistent Region. Required links are `{castId, casterUuid, spellUuid}`. The cast transaction must compensate by deleting the Region if its later resource or chat commit fails.

Metadata lives in `flags['witcher-rilerena'].magicArea`. `updateMagicRegion(region, changes)` permits only lifecycle state, not geometry or source links. `deleteMagicRegion(region)` removes a zone. These mutations require a GM; the caller is responsible for selecting the elected authority and serializing actions.

`magicRegionEventUpdate(region, event)` returns a pure `{duplicate, changes}` plan for entry/exit membership and per-token combat-event markers. Apply its changes only when the corresponding gameplay effect succeeds. Duplicate events and combat rewinds do not repeat effects.

`magicRegionRoundUpdate(region, {combatId, round})` returns a pure duration update. It reduces duration once per new round, accounts for forward jumps, and ignores repeats or rewinds. The casting engine chooses the correct first expiration tick and must also tick empty zones: native per-token Region round events cannot expire a zone with no occupants. Out-of-combat time passage also belongs to that engine.

## Verification and limits

The helper's API contracts were inspected in the genuine Foundry V14 build 365 client: `RegionLayer.placeRegion`, `RegionDocument.updateShapeConstraints`, `TokenDocument.testInsideRegion`, native circle/cone/line data models, and `RegionBehaviorType` static events.

Automated tests use controlled fixtures for placement cancellation, conversion, authority revalidation, explicit table conventions, spherical height, overrides, persistent metadata, and event deduplication. These fixtures do not establish live canvas behavior. Forge acceptance should check placement with walls, large tokens, scene levels, elevated flying tokens, player cancellation, and persistent-zone entry/exit.
