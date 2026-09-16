# Critical wound cards

Available in **0.1.0-alpha.5**, for Foundry V14. **Critical Wounds** contains all
**24 Core injuries**, with source pages and effects at all four stages.

## Applying an injury

Drag a card onto a character, NPC or monster sheet and select the injured hit
location. Combat creates the same kind of card automatically. Each injury is
a separate embedded Item; multiple injuries of the same kind can coexist.

Dropping a card applies its effects without repeating the original attack's
damage or generic critical-hit Stun save. Concussion rolls its save interval
once; Lost Teeth rolls its tooth count once. The results are saved. Heart Damage
triggers its immediate Death save. A fatal neck injury kills the actor. Organ
injuries are rejected for organless creatures; use combat for their replacement
critical damage.

Open the card from the actor's wound list to see its location, current effects,
all stages, treatment requirements, progress and recovery days. Injury cards
do not add inventory weight or occupy hands.

## Treatment

| Severity             | Medical DC | Healing Hands rounds | Magic DC | Successful Healing uses |
| -------------------- | ---------: | -------------------: | -------: | ----------------------: |
| Simple               |         12 |                    2 |       14 |                       4 |
| Complex              |         14 |                    4 |       16 |                       6 |
| Difficult            |         16 |                    6 |       18 |                       8 |
| Deadly, if treatable |         18 |                    8 |       20 |                      10 |

Checks must **beat** the DC. **Medical action** offers:

- **Stabilize — First Aid:** one successful check changes the card to
  stabilized. Healing Hands can substitute for First Aid.
- **Treat — Healing Hands:** spend the required rounds, then make **one**
  Healing Hands check. Success applies treated penalties and starts recovery.
  A failed check resets that attempt's treatment-round counter.

In combat each treatment action records one round and uses normal action/STA
rules. Outside combat, enter elapsed rounds. The healer must have Healing Hands
to use it. An injured healer selects the arm or arms used; relevant penalties
and unusable limbs are enforced. Optional manual d10 uses the same exploding
and fumbling checks as combat.

The requester must own the patient and healer, or be GM. Player requests need
an active GM. A changed wound or combat turn rejects a stale dialog. GM buttons
can instead record successful stabilization or treatment resolved at the table.

**First Aid stabilization does not begin recovery.** Ordinary condition-ending
actions can separately stop bleeding or poison without stabilizing the whole
injury; its other penalties remain.

## Magic counter

The GM records successful Healing uses resolved at the table. The card states
the Spell Casting DC. Reaching the required total changes it to treated and
starts recovery. These uses do not restore HP under the critical-healing rule.
The counter does not cast a spell, roll Spell Casting or spend spell resources;
the magic system remains deferred.

## Recovery and permanent consequences

Temporary injuries use Core's BODY 3–13 recovery table, using BODY after treated
modifiers apply. **Recovery days** advances one wound; actor **Rest** advances
all eligible treated wounds. At zero days a temporary wound becomes healed and
its penalties disappear. The card remains as history and can be deleted later.

GM can mark a treated wound healed when recovery was tracked elsewhere.
**Permanent consequences still apply in the healed state while the card is
present.** Treatment and elapsed days do not restore a lost body part. The
corrected recovery table has no ordinary timer for Deadly injuries.

**Foreign Object** modifies Critical Healing, but the supplied rule does not
define an unambiguous conversion to extra days. The GM must set the duration.
BODY outside the printed 3–13 table also needs a GM duration. If Critical Healing
modifiers change, advancing a clock pauses it for review without deducting days.
Progress is retained until the GM sets remaining days.

Selected-limb penalties affect checks using that limb; eye penalties affect
visual Awareness only. Skull Fracture replaces head damage with ×4. Stamina
penalties cap available STA; treating/removing the injury does not refill spent
STA. Recurring conditions and saves follow the current stage; healed ordinary
injuries no longer tick.

## Existing worlds

Old wound Items remain usable, recognized by name/severity if they lack a
catalog key. Saved stage, location and remaining days are retained.

Older releases placed bleeding/poison/suffocation into general actor condition
flags without recording their origin. The treatment dialog lets GM explicitly
clear those legacy flags. Review the warning: another effect may also cause
that condition. New wounds track their sources independently; treating one
does not remove another's condition.

## Sources and verification

Core Rulebook v1.35, printed pp.158–162 and 173–174; supplied 2022 Core Errata
clarifies one Healing Hands check after treatment and removes Deadly from the
recovery table. Descriptions are paraphrased; PDFs are outside the release.

Automated tests cover the catalog, cards, stages, healing, recurring effects,
authority, stale requests and persistence failures. Fields are checked against
Foundry V14's actual data models. See the [Forge checklist](forge-checklist.md)
for live checks still needed on the user's installation.
