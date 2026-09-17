# Focus and Greater Focus

## Source rules

Core p.72 distinguishes Focus, which reduces casting STA, from Greater Focus, which makes the spell's DC two points higher when casting through the weapon. Crystal Staff (p.74) and Elven Walking Staff (p.83) have both. The two Binding staves in Tome pp.148–149 also have both; their separate cage interactions do not change this property.

The imported Core relics preserve their restrictions in their effect text:

| Relic           | Greater Focus elements | Core page |
| --------------- | ---------------------- | --------- |
| Devine          | Air                    | 257       |
| Caroline        | Water                  | 258       |
| The Abyss Guard | Water                  | 260       |
| Succubus’ Wand  | Fire                   | 261       |
| Fate            | Water, Fire            | 262       |
| Moon Blade      | Unrestricted           | 263       |
| Maugrim         | Earth, Water           | 263       |

An element-limited Greater Focus does not turn a mixed/unspecified spell into a matching element. Numeric Focus remains its own property: for example, Succubus’ Wand's Focus (5) is not restricted by the separate Greater Focus (Fire) qualifier. Unknown qualifiers fail closed rather than becoming unrestricted bonuses.

## Implemented interpretation and execution

The authoritative casting command validates the selected item through `selectedMagicFocus`: the item must be carried, equipped, actually held with a legal grip, and usable by that tradition for that magic kind. A Greater-only focusing weapon can be selected even when its numeric Focus value is zero. An unselected weapon grants no bonus. Multiple selected focusing items do not stack; separately selected worn elemental glyphs follow their own [enhancement rules](enhancements.md#spell-glyphs-and-focusing-words).

The cast snapshots the selected Greater Focus's identity, printed elemental restriction, and applicable defense bonus. Its **raw casting check is unchanged**. A distinct spell defense DC is the raw check plus the saved bonus:

- A target's active Dodge/Escape, Reposition, Block, or Resist Magic defense compares against that DC; a tied opposed defense succeeds.
- Passive defense compares the same effective spell result against the target's passive DC.
- Dispel must exceed the target spell's DC; Heliotrope may tie it. The counter-caster's own Greater Focus does not add to their check.
- Talfryn's escape and Cursed Illness's Endurance recovery retain their strictly-greater comparison with the saved boosted DC.
- Puppet, ongoing regions, repeat opposition, and subsequent magical attacks keep the original spell's focus snapshot. A fresh Spell Casting check supplies a new raw total, then adds the saved defense bonus exactly once.
- Moving, destroying, or changing the focus after the cast does not retroactively change the spell. A subsequent new cast must validate its own selected item again.

This separates the source's “spell DC” wording from a universal Spell Casting skill bonus. Healing treatment checks, casting against a prerequisite DC, damage based on the difference between raw rolls, physical critical margins, duration, power, and fumble severity receive no +2. Unmodified attribute recovery dice such as the mental recovery die against INT also receive no adjustment. Existing spells without a saved focus keep their prior DC; the system does not guess which equipment was used historically.

Only currently supported spell procedures are enabled. DC metadata in other audited spell plans does not enable their missing runtime procedures.

A spell granted by an enchanted amulet uses that amulet's own required Focus path, so it cannot simultaneously borrow a held staff's Greater Focus. The ordinary selected-focus path remains available for the actor's learned magic.

Core p.166 destroys carried focusing items on the relevant catastrophic magical fumble. This includes an eligible Greater-only focusing weapon; the explosion's item consumption and chat receipts use the existing compensating transaction.

## Validation

Tests cover actual imported relic restrictions, a selected Crystal Staff cast followed by real defense/damage, tied defenses, raw physical critical margins, unselected/Greater-only weapons, amulet separation, counters, fumbles, critical healing, Talfryn escape, Cursed Illness recovery while Stunned, and continuing attacks with both saved and fresh checks. Rollback tests cover focusing-item destruction. Existing magic workflow, UI, ongoing, and restraint regressions remain required.

These are executable document/authority fixtures and source checks. They are not a claim of a live Forge acceptance test.
