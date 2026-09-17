# Spell and invocation targeting audit

`magic-targeting.js` provides source/page-backed profiles for all 180 Core and Tome spells/invocations. It does not imply that the effect executor supports every profile. Source: Core v1.35 pp.102–113, Tome v1.01 pp.82–100 and132. Numbers below were checked against the local book extracts, including effect prose rather than only each Range field.

## Significant corrections

| Magic                    | Actual targeting                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threads of Life          | Every target within10m of the caster; private information benefits the caster.                                                                     |
| Healing Rest             | Chosen targets within5m, maximum Spell Casting skill value.                                                                                        |
| Presence of the Divine   | Caster voice/intimidation mode, or up to6 fear-immune targets within10m.                                                                           |
| Silverlight              | Up to5 targets within2m.                                                                                                                           |
| Sigil of the Hunt        | Up to6 targets within2m.                                                                                                                           |
| Tryferi Gaeaf            | `floor(Spell Casting / 2)` independent spikes; allocate among targets within20m, including repeat attacks against one target.                      |
| Alzur's Thunder          | Straight line out to25m; nearest targets first; reduce subsequent damage by1d6 per previous target.                                                |
| Sagitta Aurea            | Straight line out to20m; each target defends separately; no Alzur-style damage reduction.                                                          |
| Bekker's Rockslide       | One primary target; separate6m impact area with Athletics DC16.                                                                                    |
| Wrath of Nature          | 60m command area; each terrain attack uses its own actual shape/count/range. Shore has two jets against one or two targets within20m of the spout. |
| Hand of the Tempest      | One launched creature/object, one manipulated object, or a14m cone depending on mode.                                                              |
| Web of Roots             | Cast on a tree within10m; subsequent attacks target one creature within10m of that tree.                                                           |
| Conspiracy of the Mother | Up to10 existing crows within half a mile; at most10 bonded at once.                                                                               |
| Dust Coating             | Broad10m-cube reveal plus one selected maintained coating beneficiary.                                                                             |
| Flaming Vortex           | Place/control a2m-wide tornado within10m; only creatures it crosses take its attack.                                                               |
| Aenye / Breath of Fire   | One target each. The words fireball/breath do not supply an area absent from the printed effect.                                                   |
| Blessing of Love         | Effect explicitly names the caster despite printing Range5m.                                                                                       |

The profile distinguishes immediate actor targets, self effects, owned/environmental objects, placement points, existing magical effects, and special procedures. A self buff with a separate listener/subject has explicit role metadata; portals separate their nearby entrance from their distant remembered destination.

## Table rulings retained

The books do not provide cone angles or beam widths. No90-degree cone or1m beam is inserted as if printed. Record a GM choice for those dimensions/intersections. Sigil of the Hidden, Curse of Sedna, and Stammelford's Earthquake say an area size without defining its shape/radius. Retribution of the Raven prints20m and refers to an area without labelling a radius. The existing effect registry and targeting profile retain an explicit GM radius decision for the latter.

`requiredChoices` prevents count validation before a necessary choice is available. `areaGeometry` accepts an actual positive circle/rectangle/cone geometry and labels it as a table ruling. The Curse of Sedna's5m Swimming-check zone is separate from its ambiguous4m whirlpool description.

`validateMagicTargetCount` only validates distinct actor counts. The runtime must authoritatively validate actual token distance, area membership, line order, walls, creature/object eligibility, source/target ownership, and projectile allocation. `maxTargets:null` means all eligible targets for an area or line, or an unresolved context-dependent limit; check `requiredChoices` before treating it as unlimited.
