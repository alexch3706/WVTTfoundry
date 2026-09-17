# Verbal Combat

The actor's Social tab starts an optional argument with separate Resolve, participant goals and a durable chat record. The implementation uses Core pp. 176–177, the p. 177 errata, and the related Core/Tome rules detailed in [the source audit](social-combat-audit.md). It does not spend HP or create physical critical injuries.

## Playing an argument

1. Select participating PC/NPC actors, their goals, opposing sides and turn order. Record the audience for public arguments and any skills to which an established Reputation applies.
2. The start form includes a collapsed **Table rulings** section. Its editable defaults are recorded in the encounter. These resolve ambiguities left by the printed rules; they are not additional rules attributed to the books.
3. Open the chat card to declare an attack against one or several opponents, or use a full-turn tool. Each attacked actor's owner selects a defense. The completed exchange applies Resolve damage and any appropriate consequences once.
4. Continue until participants reach zero Resolve, successfully Disengage, or the GM ends the argument. The record preserves goals, rolls, damage, outcomes, rulings and relationship changes. A new argument starts its own Resolve pool.

All seven attacks and four defenses are implemented, including Counter-argue with the selected attack's damage and consequences. Check and damage attributes are distinct: Deceive uses EMP for its check and INT for damage, for example. Checks use the system's normal exploding/fumbling Witcher d10 procedure and accept validated manual die input. Opposed ties block the attack; the recorded convention determines whether a tie also deals return damage. Fixed DCs require a result strictly greater than the DC.

The engine handles cumulative Seduce, Appeal and Intimidate effects, separate defenses for multiple targets, the selected group-resolution convention, finishing outcomes and Disengage. Resolve remains encounter state, independent of HP and STA. When linked to Foundry Combat, verbal actions use the actual turn budget, tools consume a full turn, and extra actions/additional defenses use the chosen action-economy convention. Study expiration follows the recorded boundary and the actual Combat clock; extra actions do not advance that clock.

## Tools and lasting consequences

- **Study:** the printed Human Perception versus target INT × 3 check, with recorded scope and expiry.
- **Romance, Imply and Bribe:** the books do not print their opposition. The GM records a DC or opposed skill when a tool is first used; the system never substitutes Study's DC. Failed tools do not grant their success effect.
- **Romance:** a directed −3 relationship modifier. Ending it badly replaces that effect with the printed permanent +3 defense against this romancer's empathetic attacks. The encounter menu provides the lifecycle operation.
- **Imply:** −4 defenses after success, with recorded once-per-argument consumption policy.
- **Bribe:** tracks the offer and its empathetic-check bonus. An offer does not itself debit currency. The separate transfer operation checks actual funds, moves Crowns to the recipient, and rejects repeated payment.
- **Befriend:** finishing victories advance the target's directed relationship through acquaintance, dedicated friend and blood-brother, capped at the third printed level.
- **Public Ridicule:** each qualifying success records −2 Reputation with that audience for one day. It does not alter the actor's base Reputation or affect an unrelated audience.

The Social tab displays named relationships and active audience-specific Reputation changes. A completed winning agreement can also supply a validated result to the separate demon-binding workflow; the binder still validates the exact participants, agreement and cage time limit.

## Context and related rules

The GM can record situational modifiers, regional social standing, feared status, audience knowledge of Reputation, and the relevant skills for a Face-Down bonus. Human Trustworthy, Odious Hex, and active eligible Botchling/Succubus/Leshen trophies are applied with their correct scope. A Leshen trophy enables only the animal negotiations the book permits. An unbound demon still requires a bargain beneficial to it; a high roll does not bypass that requirement.

Recognition uses the printed unmodified d10 against effective Reputation. Face-Down uses its printed d10 + WILL + Reputation contest and applies the winner's appropriate +3 to recorded relevant checks against that opponent. Recognition handling for negative Reputation and repeat Face-Down attempts are saved conventions. Human Blindly Stubborn can use a preauthorized reroll of a failed Resist Coercion check, keeps the better result, and consumes the actor's actual three-per-session allowance; a GM operation resets that allowance for a new session.

Torture modifiers require an adjudicated record of actual damage and the victim being at the interrogator's mercy. The system can use an applied damage card as evidence. It grants no free physical damage, restricts the numeric bonus to Intimidation, and rejects torture against a reanimated corpse. Such a corpse can speak and use its printed −3 Resist Coercion despite its underlying dead condition. A bound demon can participate verbally through its cage while its separate physical restrictions remain active.

Narrative validity, contradictory group goals, the caring relationship needed to maintain Romance, the extent of friendship, and audience/context judgments remain GM decisions. General profession and creature abilities beyond the explicit integrations above are not claimed as automated by this subsystem.

## Persistence, authority and validation

`social-rules.js` provides pure rule calculations. `social-runtime.js` registers authoritative commands and persists the GM-owned encounter card; `social-ui.js` supplies actor/chat interactions. Actor writes use the existing transactional commit mechanism. Revision checks and completed-exchange receipts reject stale or duplicate resolutions; later failures compensate earlier relationship, currency, Luck and action-budget writes.

Commands: `socialStart`, `socialDeclare`, `socialDefense`, `socialRuling`, `socialTransferBribe`, `socialRecognition`, `socialFaceDown`, and `socialClock`. The integration APIs are `registerSocialCommands`, `registerSocialUI`, `socialActorDisplay`, `startSocialCombat`, `openSocialEncounter`, and `validatedSocialVictory`.

Validation: **37 passing tests** across `social-rules.test.mjs`, `social-workflow.test.mjs`, and `social-ui.test.mjs`. They exercise actual registered commands, actor/item/message changes and dialog callbacks in the repository's document fixture, including all attacks/defenses, multi-target exchanges, tools, ties/DC boundaries, cumulative effects, action/STA budgets, friendship progression, Romance aftermath, audience expiry, currency transfer and rollback, trophy/corpse/demon rules, and unauthorized/stale/duplicate requests. These are automated document-workflow tests; a live Forge session remains a separate manual check.
