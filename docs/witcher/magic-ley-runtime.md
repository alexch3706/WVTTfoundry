# Ley Line casting and amulet authorization

Source: _A Tome of Chaos_ v1.01, printed pages 8–9 and 117–118.

The casting, counter and upkeep commands now apply additional Ley consequences
in the same actor transaction as ordinary costs and fumbles. Priest/Druid
penalties stack as separate −2 Vigor effects with six-hour expiries. Earth
disconnects and preserves a per-source +2 reconnection DC. Water adds a real
source-owned Hallucinating condition; disconnect keeps it for at most one minute.
Already planned ordinary conditions, effect consumption and upkeep receipts are
preserved when those effects are merged.

## Air access and replacement

Real embedded magic Items use `flags.witcher-rilerena.leyBorrowed={sourceUuid,key}`.
They cover Air spells at levels for which the mage knows an actual Air spell.
Borrowed spells and amulet grants never supply the level knowledge themselves.
Disconnect removes the Items, and every casting revalidates the current source
and actual native knowledge even before a cleanup hook executes. Forgotten magic
does not establish a known level. The source must still be physically touched,
and its actual configured element must match the saved connection.

An Air fumble/overdraw saves a mandatory `replaceSpell` job. The original effect
cannot be applied while waiting. The GM chooses a different implemented Air spell
of the same level; its normal choice fields, native area preview, target check,
preflight, defenses and application are used. It retains the original casting
total, goes off despite the fumble and charges no second STA payment. Original
ordinary fumble/overdraw damage still applies.

The strict selector cannot execute an unimplemented catalog reference. Each
required level needs at least two implemented Air spells for all replacement
choices to be meaningful. Signs lack a spell level in this table; such a mismatch
requires a GM ruling rather than inventing a level.

## Fire forced casting

The extra consequence persists as a `repeatSpell` job. A server roll chooses and
saves a random actual token within the spell's range; repeated clicks reuse the
same choice. The normal native area/target review must include this saved target
(point effects must be placed at its position).

The resolver pays the original actual spell STA plus 3 STA, increments the extra
action budget even if the normal optional extra action was already used, and
applies −3 to a new actual Spell Casting check. It applies ordinary fumbles and
Vigor overdraw, without recursively triggering another additional Ley effect.
Every mutation and resulting card is compensated on persistence failure.

If the caster has insufficient STA, or no actual eligible target exists, the job
remains visibly pending for the GM. It never grants a free cast or invents negative
STA. The book does not provide an alternative resolution for those exceptional
cases. Object/point spell choices still need normal authoritative preflight.

## Runtime and UI contract

- `planAdditionalLey(actor,data,changes,cost,result)` merges consequences into
  existing changes. Pending jobs live in `system.magic.leyConnection.pending`.
- `magicLeyChoose` saves the GM's Air choice or the server's random Fire target.
- `magicLeyResolve` checks the saved job version and performs actual casting.
- Chat controls load `resolveLeyUI` in `magic-ley-ui.js`, which reuses the actual
  casting UI and native Region placement.
- Generic voluntary action consumers must block past a pending mandatory job;
  ordinary magic cast/counter/upkeep already enforce this.

## Amulets

`learnedMagic` checks each grant against the actual complete, equipped, carried
amulet and stored key. Casting and counter costs force Focus 2, disallow all other
focus substitution and require sufficient Vigor including current-round spending.
Priest/Druid casting may use a stored mage spell. Upkeep retains the amulet source
identifier, rechecks it and never discounts an already discounted upkeep twice.

Additional compatible fixes: ongoing attack cards allow Heliotrope while the
target status is `ongoingPending`; those counters spend a defense. Repeated
damage cards use `executionId` to avoid colliding with earlier applied damage.
Persistent zones marked by their targeting profile create a Region directly and
reserve defenses for their actual repeated attacks. Artifact Compression rejects
generic removal and directs the GM to its actual reversal control.

Tests: `magic-ley-runtime.test.mjs` exercises real registered commands using
controlled document persistence. It covers casting, counter and upkeep triggers,
Air creation/revocation, actual replacement application, Fire random target/cost/
fumble/rollback, and actual priest amulet casting/upkeep. This is not a claim of
live Forge or browser acceptance.
