# Continuing magic procedures

`magic-ongoing.js` executes saved procedures through the system's existing authority queue. It does not independently declare a spell fully implemented. The caller must check its target selection, immediate operation executor, modifier hooks, and continuing operation support.

## Implemented procedures

- Per-round damage/healing/resources/conditions, explicit entry/exit/contact/impact events, paid maintenance events, and expiry operations.
- A saved defense precedes damage. Original attack totals stay fixed unless the book explicitly requests a new Spell Casting check. Explicitly opposed defenses (saved attack totals or a new Spell Casting check) win ties. Fixed printed DC checks and Cursed Illness Endurance recovery must exceed the DC. Web of Lies instead requires one unmodified d10 **strictly below current INT**, including current stat modifiers.
- Web of Lies, Cursed Illness, Light of Truth, Hold Tongue, Vahila's Smoke, Spectral Tether, and Shade of Bleobheris have actual repeat-resistance procedures. Their separate persistent restrictions still require modifier hooks.
- Active spell actions use saved operations, actual selected target documents, a target-validation adapter, and an action/payment adapter. A player cannot submit an arbitrary operation or bypass the action budget.
- Restraint escape saves, explicit hit-triggered endings, and delayed `arrivalRounds` summons use the same transaction mechanism.
- Environmental facts absent from document data become an explicit GM decision. Static Storm never infers metal from an item name. A completed Healing Rest gates **both** its HP healing and wound recovery together.
- Native Region events use persisted membership transitions and per-token combat cursors. Repeated event delivery and combat rewinds do not repeat a resolved tick. Leaving and entering again counts as a new entry when the printed spell uses entry triggers.

The capability manifest lists the exact events/rules handled here. It does **not** advertise unsupported special creature profiles, the Hand of the Tempest landing/collision procedure, item-consumption systems, environmental movement replacement, or every registry trigger.

## Integration

Register once with `registerMagicOngoing({ registerCommand, runCommand, resolveUuid, executeOperations, rollCheck, rollFormula, postMessage, reserveAction, validateActionTargets, schedule, isAuthority, registerHooks: true })`.

`schedule(task)` must enter the existing elected-GM queue and return a promise. Public trigger/tick/resolve functions are **unscheduled**, so they can also be awaited inside an already running authoritative command without recursively queuing it.

Adapters:

- `executeOperations(operations, context)` returns `{receipt, rollback}`. It must execute nested attack/hit/penetration rules itself and preserve their source information.
- `rollCheck(actor, {skill, purpose, pendingRole, values, dc, effectId})` uses the ordinary check system. `values` preserves full manual exploding-dice input, Luck, modifier, defending weapon, and injured arm. Validate all input in this adapter. Return `rollback` when the check changes resources or action state. `pendingRole` distinguishes `ongoingDefense`, `repeatResistance`, and `opposition`.
- `rollFormula(formula, {actor,purpose})` returns a number or `{total}`.
- `reserveAction(actor,{action,eventId,maintenanceCost,effectId,castId,event})` returns a rollback receipt. Normal/full-round/escape actions are charged here. Automatic defenses are charged by the check adapter when appropriate. Verify previously paid upkeep to avoid charging the same maintenance twice.
- `validateActionTargets(operations,context)` checks actual range, scene, line of sight, maximum targets, and eligibility. Its absence prevents an action from executing.
- `postMessage(data)` creates a real ChatMessage. Player prompts are whispered to the Actor's owners and GMs; adjudication prompts are GM-only.
- Optional `predicate(key,operation,context)` returns `true`, `false`, or `undefined`. Undefined produces a GM decision, never assumed eligibility.
- Optional `promptInput(pending,{actor,source})` provides the system's complete defense/action dialog. The fallback covers basic manual dice and selected targets; blocking weapon selection belongs to the system adapter.

`installMagicOngoing(actor,operations,context)` creates a real saved Actor effect and returns a rollback receipt. `ongoingEffectData` returns only the source if the caller is already combining one atomic Actor update. Store `sourceMagic`, original caster, cast ID/total, source message, token, scene, placement, original cast data, and duration.

The existing lifecycle must skip `effect.magic.ongoing.managed`: this engine owns its last tick and expiry. Legacy sign healing and Puppet resistance stay with their existing lifecycle and are deliberately ignored here.

For Regions, store `operations`, `key`, `casterUuid`, `castId`, `castingTotal`, placement/source fields, `expires`, and `excludesCaster` in `flags['witcher-rilerena'].magicArea`. Call `triggerMagicOngoingRegion(region,event,context)` from the existing native behavior dispatcher. Its bookkeeping is in `flags['witcher-rilerena'].magicOngoing`; it does not overwrite the behavior class. Region expiry must let required pending defenses finish before deleting the source.

The combat damage finalizer ends the entire Suffocate cast when a weapon actually strikes its caster, after damage is committed. All affected creatures and the caster marker are cleared together. Ordinary suffocation does not add another 3 damage while Suffocate supplies its printed 1d10. Damage/attack events cannot be initiated through the player command payload.

## Persistence and failure behavior

Pending requests live with their source, not only in chat. Commands accept an existing pending ID, recheck actor ownership and current source state, and use the saved operations. Every document write snapshots its original fields; nested execution/action receipts are rolled back if later writes fail. A rolled-back event can be retried.

World-time catch-up processes exact three-second boundaries with a maximum of 100 rounds per callback; it retains the next unprocessed boundary. It never skips damage, silently assumes defenses, or deletes a source before catch-up finishes. Expired sources retain unresolved mandatory attack defenses and completed-rest decisions; voluntary resistance/actions become unavailable.

Engine and command/document workflow tests cover actual mutation, rollback after partial writes, permission checks, idempotency, manual dice forwarding, derived INT, action payment, defense-before-damage, last-round defenses, multi-part rest gating, Region re-entry, and delayed arrival. These are unit/integration seams; a Foundry V14 world smoke test is still required after all adapters are connected.

## Connected runtime

`registerContinuingMagicRuntime()` connects the existing elected-GM command queue, complete manual checks, ordinary defense actions, actual weapon blocking and reliability, source-aware spell effects, and native Region creation. It registers `createContinuingZone` with the effect executor; `registerMagicZones` dispatches native token events and catches up world-time area rounds. The runtime validates range, current scene, line of sight and target count before charging an active action.

An active attack creates one recorded attack card and separate saved defense procedures for its actual targets. Printed rules select the original casting total or a fresh check. A severe casting fumble applies the real elemental consequence and creates no defenses. Defensive fumbles pause the hit until the existing combat-fumble command records their consequences; resuming reuses the saved check and never charges Luck or another action. A helpless creature may explicitly accept a hit. Heliotrope resolves only the protected target; Dispel ends the linked source.

Immediate printed saves are offered during initial effect application. Their one-shot Actor sources disappear when all their procedures finish. Persistent Regions keep final-round mandatory saves after expiration and disappear after resolution. Initial contact and the native entry callback cannot duplicate the casting-time effect.

These connections do not enable every catalog entry. Caster-controlled terrain areas, special summon profiles, specialized equipment attacks and rules without their own complete executable procedure remain rejected by the support predicates. Native geometry is exercised through controlled V14 document interfaces here; live Forge acceptance is still required.

Cursed Illness recovery is an explicit Magic-tab action. It pays a normal action, remains available while Stunned, and must beat the original casting total with Endurance. Ordinary Stun recovery cannot bypass the invocation. A pending recovery card may be retried on a later legal turn without manufacturing a new casting total.
