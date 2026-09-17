# Healing invocations and critical-wound cards

Sources checked directly against the supplied books: Core Rulebook v1.35 pp.110, 113 and 173–174; A Tome of Chaos v1.01 p.95.

## Implemented procedures

| Invocation          | Actual procedure                                                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blessing of Healing | Choose HP recovery or a critical wound on the selected target. Initial cost is 5 STA. HP mode restores 3 HP per round and uses the existing active-magic procedure with 3 STA upkeep. Critical mode counts one successful use per actual casting, restores no HP, and does not start an HP/upkeep effect. |
| Healing Rest        | One 16 STA casting can affect up to the caster's Spell Casting skill rank in targets within 5 m. Each selected subject enters a one-day coma. After a full day of world time, recover HP and heal treated critical-wound cards. Untreated wounds and permanent consequences remain.                       |
| Miracle of Lebioda  | One 16 STA casting entirely restores one wound on a living target within 2 m, including its permanent consequences and missing anatomy. The restored card stays as history, with its previous state recorded in an Item flag. The invocation does not separately restore HP.                              |

Blessing's critical mode uses the existing magical wound treatment routine and Core's treatment table: simple 4 uses/DC 14, complex 6/DC 16, difficult 8/DC 18, deadly 10/DC 20. The casting total must **exceed** the DC. Finishing these uses treats the wound and starts the normal BODY-based recovery clock; it does not skip the later healing period. A failed treatment check still consumes the actual casting resources. Another successful use requires another casting, rather than one upkeep payment.

Miracle restores the active mechanics of a missing arm/leg or damaged eye by clearing the selected card's injury consequences. It also resets the recorded tooth loss from Broken Jaw after that wound's temporary penalties have healed. The original wound data remains in `flags.witcher-rilerena.miraculousRestoration.previousWound`. Restoration does not remove another wound or an unrelated condition.

## Healing Rest clock and interruption

The effect saves its exact start/end world times. Clock updates complete the recovery only after the full 86,400 seconds. Touch, damage, ordinary Stun recovery and Recovery Actions cannot wake the subject. A player cannot voluntarily move the resting token; GM movement and forced movement remain possible for carrying or displacing the body. Death saves remain available when the body suffers damage.

Dispel or removal before completion ends the coma without granting early healing. The condition cleanup preserves unconsciousness which existed independently before the invocation. A subject who dies during the rest is not resurrected. Brand of Withering still prevents HP recovery, while the invocation's separate treated-wound restoration remains a distinct operation. Healing Rest retains the permanent penalties from deadly wounds; Miracle is the separate procedure that removes them.

Every actual target is validated before casting resources are spent. Selected wounds are fingerprinted at casting and checked again at application, so changing a wound while a spell card is pending cannot redirect or duplicate its treatment. Committing the result saves the Actor receipt, Item changes and chat result together; failure restores the previous state.

## Source cleanup used by the magic clock

`magic-source-cleanup.js` now supplies the shared cleanup for explicit Dispel/end actions and automatic upkeep expiration. Ending a maintained cast removes its source effects, restores temporary equipment changes, and removes its native magic/ritual Regions. Ordinary fire marked as persisting after its originating spell remains active, as do other casters' effects.

Cleanup can return a compensation transaction. If a later Region deletion or clock write fails, deleted Regions are recreated with their original IDs and full saved data; original active flags, enchanted equipment, Actor effects and healing progress are restored. The clock recomputes its plans after successful source cleanup so a stale occupancy plan cannot reinstall an expired fog. This helper does not claim to delete arbitrary summoned creatures: their individual summon/ritual lifecycle remains separate.

## Verification

- 11 real command/workflow tests cover distinct paid critical castings, DC ties, HP ticks and upkeep, eligible target/wound selection, rank-based target counts, missing-arm and tooth restoration, one-day rest, interruption and rollback.
- 3 cleanup workflow tests cover partial Region deletion, simultaneous expired casts plus equipment and later healing failure, and preservation of ordinary fire/other sources.
- Existing 27 lifecycle tests pass, including round/time tracking and rollback.
- The Dormyn's Fog actual cast/Region regression now passes: unpaid upkeep removes the Region and restores native sight after occupancy refresh.

These tests exercise the registered system procedures with controlled document persistence and dice. They do not substitute for a live Foundry V14/The Forge session.
