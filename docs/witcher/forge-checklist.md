# Foundry V14 / The Forge acceptance

Version: **0.1.0-alpha.2**. **Live run pending.**

1. Install the pinned release manifest and create a Witcher world in V14. Open
   a character, NPC, monster and Item sheet; check the browser console.
2. Open all **11 packs**: **809 catalog Items**, **36 Actors**. Import a Witcher
   sword, armor, crossbow/ammunition and Tools school equipment. Open recipes.
3. Drag a weapon onto a PC sheet; equip it; check hands, carried weight and EV.
   Test a two-handed weapon in one hand (−3) and a shield occupying the other.
   Drag an owned item from the inventory to another sheet.
4. Put the PC and a Bandit in a combat. Target the correct token. Attack Fast;
   choose Dodge/Block/Parry from chat; apply damage as GM. Finish the second
   strike. An extra action costs 3 STA once and applies −3 to both fast strikes.
   A strong attack is one strike at −3 with double damage before armor.
5. Open a second-strike dialog, advance the turn, then submit: it must reject.
   Open two defense dialogs for one attack: only one may roll/spend. Check first
   free defense, subsequent 1 STA and round reset. Test unarmed Parry/Brawling.
6. Select ammunition, reload a crossbow and fire. Quantity and loaded state must
   persist after refresh. A hand crossbow also needs two hands to reload.
7. Import Griffin: Claws twice OR Bite once per round; an extra action cannot
   reset ROF. Import Drowner, Arachas, Rock Troll, Golem and Noonwraith. Verify
   natural damage, weak SP, infinite STA, silver resistance and physical immunity.
   Core supplies no natural weapon REL: configure it on the weapon sheet before
   testing a claw block; then check REL wear and broken-weapon rejection.
8. Place two unlinked Drowner tokens; damage to one must not change the other or
   the world Actor. Place multiple linked tokens and check targeting/distance.
9. Change armor before applying a damage card; review recalculation with existing
   dice. Double-click Apply; damage/wear must apply once. Exercise critical wounds,
   unconsciousness, death saves and round effects.
   After damage, compare current/max SP in Combat → Hit locations, Equipment
   and the owned armor item sheet. Unhit locations and the compendium source
   must stay unchanged; a fully broken location must display 0 / maximum.
10. Equip Tools armor and trigger its school reaction. Check once-only choices,
    follow-up attack/defense, Manticore movement/prone, and visible Griffin deferral.
11. As GM and player, test requests/permissions together. No player can act for
    an unowned actor or apply GM damage. Disconnect/reconnect around a pending
    request; inspect any reported persistence failure before manually retrying.
12. Use a Journal mutagen and process Crystallized Essence with Crafting DC 10;
    verify material consumption/output. Exercise a school diagram and repairs.

Report the release version, failing step, reproduction and console error. Tests
of deferred magic, profession/creature active powers, mounted combat and area
bombs are outside this acceptance pass.
