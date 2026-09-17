# Alchemy lifecycle and crafting

Sources: Core v1.35 pp.127, 142, 246–248; A Tome of Chaos v1.01 pp.97, 115–116, 147. The separate `alchemy-audit.md` records the pre-implementation baseline; its missing-feature rows are not a release support checklist.

## Inventory and effects

`alchemy-rules.js` supplies source identities for all 12 Core potions, 10 decoctions, 12 oils and the seven Tome elixirs. Owned items retain recognition after renaming when their compendium source or canonical flags are present. Effect records preserve the old printed `key` and carry `alchemy.key` for real rule consumers.

`alchemy-runtime.js` handles item use through the existing elected GM authority. It validates current ownership, inventory, carried state, action budget, actual weapon/wound choice and physical dice before spending a dose. Cross-Actor writes and the result chat are compensated together. A recorded request ID prevents a failed approval-card update from consuming a second dose. Applying a dose to another user's actor requires a GM application card; unprinted rulings are shown and reviewed there.

Toxicity is derived from the actual active doses. The effect producing toxicity poison records the latest dose and whether it introduced the poison condition. Expiry/White Honey can therefore end its own poison without clearing unrelated venom. Recovery checks use Endurance DC18 for toxicity, DC20 for Black Blood poison, and the ordinary DC15 for poisoning caused by a failed non-witcher ingestion. The immediate non-witcher ingestion check remains DC18. A successful toxicity recovery also ends the latest dose. White Honey still requires the initial non-witcher check; Core p.246 gives no exception.

Full Moon preserves the system's existing temporary-HP absorption pool. Ending it removes only the unused temporary HP, and does not heal existing injury. The source does not define a separate pool algorithm; this is a documented implementation interpretation, not imported additional book text. Anabolic Steroids increases maximum HP without healing current HP; bonus expiry caps current HP only if it exceeds the restored maximum. Its aggression remains visibly active until the printed one-hour endpoint, without inventing forced attacks or a numerical aggression penalty.

## Last Hope

Last Hope changes a selected actual critical-wound item to treated. Its `lastHope` flag records a locked wound, not a free healing counter. Natural rest, recovery-day buttons, generic healing, removal and magical wound healing cannot bypass the Doctor procedure.

The wound's medical button first offers the Doctor's actual Healing Hands DC24 roll, including manual dice. Success reapplies that injury as untreated and ends the Last Hope dose's toxicity. Its untreated consequences return. The Doctor must then complete the normal Healing Hands treatment rounds and check; only that success releases the lock and starts ordinary recovery. Failed checks and failed persistence leave the prior phase intact. Healing Rest skips the locked wound; Miracle also respects the elixir's explicit treatment prerequisite.

## Explicit table rulings

- Tempest has no printed duration. Use requires a recorded GM duration instead of inventing thirty minutes.
- Cerebral Elixir has no printed toxicity. Use requires a recorded GM toxicity value. It removes represented Bes possession effects only, preserving unrelated spirit possession. Root combat/possession integration owns prevention of future Bes possession.
- Lightning's bonus ends on the next physical attack, so the attack consumer also ends its toxicity. A miss still spends that attack benefit.
- Last Hope's dose remains tied to its treatment effect until reapplication, White Honey or a recorded GM end; ending the dose alone does not erase the wound's Doctor prerequisite. A halfling obtains no treatment effect, so that case requires a GM duration ruling for the otherwise untimed toxicity.
- Halflings receive no elixir benefits and still receive their toxicity. Anabolic aggression is retained as an effect; the book gives no numerical penalty or forced-action procedure.
- The workflow rejects reapplication of an already active named benefit. Full Moon and Swallow explicitly prohibit stacking; the other identical-dose behavior is a conservative table policy and is not presented as additional printed text.

## Crafting

`alchemy-crafting-runtime.js` resolves the actual recipe, product, tools and current ingredients on the GM at execution time. A carried owned formula grants the written +2; memorized formulas must belong to the actor and remain remembered. An external physical recipe or forge requires a recorded GM ruling. Alchemy containing silver does not require a forge: the metal-forge restriction belongs to ordinary crafting, not Core p.142 alchemy. Repair difficulty counts actual attached enhancements while excluding mastercraft provenance. A composite word counts as one attached enhancement; the books do not specify translating its occupied rune slots into additional repair difficulty.

Ingredient consumption, created product/repair and chat form one compensated operation. Failure creates one recorded immediate recovery opportunity. Its button rolls against the formula DC and, on success, restores one actually used pure substance for alchemy or half each material, rounded up, for crafting. The recovery has its own consumed receipt; elapsed world time or another recorded combat action invalidates it. Failed result-chat persistence restores the opportunity and removes any recovered product.

Herbalism's existing structured skill substitution now receives the actual ingredient context in crafting and recovery. Known botanical materials are recognized, with an explicit GM plant-origin ruling for ambiguous inputs. A generic checkbox does not grant Spell Casting substitution. This integration does not by itself promote the Herbalism invocation to completed casting support.

Outside combat, crafting confirms that the printed time elapsed. Short formulas with a printed round duration also work in combat: one real full-turn crafting action advances one work round, and all required rounds must be consecutive. The fifth action resolves a five-round formula; a time checkbox cannot bypass this clock. Components are revalidated every work round and consumed when the attempt resolves. Longer formulas still finish outside active combat. Specialized enhancement crafting uses its own procedure.

The 25-dose Chloroform/Smelling Salts bottles retain fractional bottle quantities but validate a 1/25 dose, including floating-point tolerance. This fixes their second-through-25th uses without changing unrelated chemical effects.

## Breath and prolonged running

`alchemy-exertion.js` provides authoritative clocks after the GM records a base breath duration and a prolonged-running STA rate. Neither source gives universal baseline values. Killer Whale spends the breath reserve at two-thirds normal speed while the dose is active; uncovered time uses the ordinary rate. Exhaustion adds a source-attributed suffocation condition. Outside combat, elapsed three-second rounds deal 3 HP through the normal damage transaction; combat uses the existing once-per-turn condition damage. Restoring an actual air supply clears this source while preserving magical or wound suffocation.

A long-running clock spends the configured STA rate for elapsed time. Werewolf Decoction waives only the portion covered by its active duration. At zero STA the run stops and the Core p.48 Stun consequence applies. These clocks never invent a body-based breath formula or a universal running cost. Strider remains the printed no-sleep effect; it does not manufacture HP or STA recovery.

## Verification boundary

The new tests invoke registered command handlers and real actor/item methods against deterministic persistence fixtures. They check dose spending, cross-Actor ownership and compensation, expiry, poison-source separation, physical dice, Last Hope's entire Doctor sequence, recovery replay, crafting output and rollback, and all 25 bottle uses. These are not live Foundry browser tests. Existing magical-healing tests were also rerun after the Last Hope guards.

Ordinary chemicals beyond the bottle-count correction continue through their existing procedures; the audit documents outstanding effects such as Adhesive, Quick Fire and multi-target chemical delivery. Do not infer that this lifecycle change completes those individual consumers.

## Combat and elapsed time

`alchemy-combat-rules.js`, `alchemy-combat.js`, `alchemy-events.js`, `alchemy-time.js` and `alchemy-vision.js` connect active doses to real combat and Foundry time/vision. Arachas uses current carried weight and effective ENC; Griffin's SP bonus is separate from stored armor durability. Treating those SP additions as a non-ablated bonus is an explicit implementation reading of an otherwise unspecified interaction. Wyvern counts accepted physical strikes reaching armor, resets on injury and ends its combat accumulation with the combat. Katakan modifies the critical-table result, not the attack margin. Temporary chance bonuses are scoped to the printed effects.

Lightning is consumed by the committed physical attack, including misses and halflings receiving no benefit. Thunderbolt and Wyvern affect physical attack damage only. Enemy kill bonuses require actual death, current combat provenance where relevant, and a GM enemy-kill confirmation. A saved old attack cannot build a new combat's Wyvern/adrenaline pool. Failed receipts are retryable without repeating the damage or benefit.

Swallow skips a struck round even if armor stopped damage; Troll/Grave Hag use their own printed recovery triggers. Outside combat, elapsed whole rounds are counted only once and stop at dose expiry. Cat prepares native darkvision without overwriting the token's saved vision settings and respects the existing magical fog cap. Noon Wraith, Golden Oriole and Mongoose feed the existing condition immunity checks; Cat also blocks hypnosis. Black Blood requires actual blood ingestion, applies the printed poison and uses collision-limited recoil. Nekker prevents the actual mount panic/rearing checks while active.
