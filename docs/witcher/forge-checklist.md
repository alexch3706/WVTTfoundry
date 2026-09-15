# Foundry V14 / The Forge acceptance

For the eventual installable release. No live acceptance run is complete yet.

1. Install the manifest, create a new `witcher-rilerena` world and open PC, NPC,
   monster and Item sheets. Check startup and the browser console.
2. Open all nine packs: 673 Item records and 36 Actors. Follow recipe links.
3. Import Bandit, Drowner, Arachas, Golem and Warg. Place two unlinked Drowners;
   damage to one must not change the other or their world Actor.
4. Check Creature abilities/loot, Golem's ∞ STA and Arachas's SP 10 Back.
5. Join as GM and player. Attack, defend and apply damage; check ties, armor,
   silver, wounds and permissions. Players must not damage unowned NPCs.
6. Change armor after rolling damage: recalculate with the same dice before
   application. Double-click Apply: no duplicate damage.
7. Spend extra actions, repeated defenses, Luck and ammunition. Reload; reopen
   sheets and refresh to verify persistence.
8. Advance rounds with poison, burning Drowner, Werewolf regeneration and Golem.
   Verify their distinct immunity, damage and resource behavior.
9. Generate creature loot once; verify items/crowns and reject a second roll.
   Already carried ammunition/armor must not be duplicated.
10. Exercise critical treatment, crafting, repairs and rest. Record failed
    interactions and console errors.

Open rules in `implementation-status.md` and `bestiary.md` remain separate from
regressions: successful installation does not certify unsupported rules.
