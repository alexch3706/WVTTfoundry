# Talfryn's Prison

Core v1.35 p.103: the roots have 15 HP; a Dodge/Escape check must beat the original Spell Casting total to escape. The target's initial defense remains the ordinary spell defense workflow.

`registerMagicRestraints()` registers the narrow `supportsRestraint`, `createRestraint` and `armRestraint` execution adapters, authoritative chat controls and cleanup hooks. The normal condition operation creates the source-linked `grappled` effect. The adapter creates an actual armor-free 15 HP object Actor and Token at the victim's position, then becomes active only after that exact condition source has committed. A failed cast receipt rolls back both documents through the parent execution transaction.

A user may attack the roots token using ordinary combat. A GM can also record the actual damage total and its source on the control card; an explicit event identifier prevents the same recorded event being counted twice. Damage reduces only roots HP. It does not damage the captive. At 15 total damage the source-linked condition ends, preserving another grapple source.

The target owner can make an actual Dodge/Escape action, including manual d10 continuation input and the normal extra-action budget. Ties fail. Success removes only that casting's restraint. Dispel/source removal, deleting the root object or token, or removing the target token also cleans up the linked source and root documents. Pending objects are not cleaned up before the casting transaction arms them.

`refreshMagicRestraints()` is intentionally unserialized for authority callers. Hooks queue it on the elected GM. Tests use controlled document fixtures, not a live Foundry instance: creation/arming, 14+1 damage, duplicate damage receipts, native HP destruction, original-total escape with exploding dice, overlapping grapples and compensation failures are covered.

The enabled spell is also exercised through the registered `magicCast` → defense → `magicApply` commands: actual roots Actor/Token creation, source-linked escape, 14+1 damage destruction, failed final cast receipt compensation, and a successful retry. Adenydd's adjacent movement tests start with its real casting and end with actual falling-damage cards before and after ending the spell.
