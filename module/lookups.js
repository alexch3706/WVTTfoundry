// This is where all the magic values go, because cyberpunk has SO many of those
// Any given string value is the same as its key in the localization file, and will be used for translation

export let weaponTypes = {
    pistol: "Pistol",
    submachinegun: "SMG",
    shotgun: "Shotgun",
    rifle: "Rifle",
    heavy: "Heavy",
    melee: "Melee",
    exotic: "Exotic"
}
export let attackSkills = {
    "Pistol": ["Handgun"],
    "SMG": ["Submachinegun"],
    "Shotgun": ["Rifle"],
    "Rifle": ["Rifle"],
    "Heavy": ["HeavyWeapons"],
    // Trained martial arts get added in item-sheet for now
    "Melee": ["Fencing", "Melee", "Brawling"],
    // No limitations for exotic, go nuts
    "Exotic": []
}

export function getStatNames() {
    const actorModel = game.model?.Actor;
    if (!actorModel) {
        return ["int", "ref", "tech", "cool", "attr", "luck", "ma", "body", "emp"];
    }
    // v11 and earlier format
    if (actorModel.templates?.stats?.stats) {
        return actorModel.templates.stats.stats;
    }
    // v12 onwards
    else if (actorModel.character?.stats) {
        return Object.keys(actorModel.character.stats);
    }
    // Default fallback
    return ["int", "ref", "tech", "cool", "attr", "luck", "ma", "body", "emp"];
}

// How a weapon attacks. Something like pistol or an SMG have rigid rules on how they can attack, but shotguns can be regular or auto shotgun, exotic can be laser, etc. So this is for weird and special stuff that isn't necessarily covered by the weapon's type or other information
// If we change attack type to be an array, we could say, have ["BEAM" "LASER"]
export let rangedAttackTypes = {
    auto: "Auto",
    // Strange ranged weapons
    paint: "Paint",
    drugs: "Drugs",
    acid: "Acid",
    taser: "Taser",
    dart: "Dart",
    squirt: "Squirt",
    throwable: "Throw",
    archer: "Archer",
    // Beam weapons
    laser: "Laser",
    microwave: "Microwave",
    // Area effect weapons
    shotgun: "Shotgun",
    autoshotgun: "Autoshotgun",
    grenade: "Grenade", // Separate entry from throwable because grenades have different throw distance
    gas: "Gas",
    flamethrow: "Flamethrow",
    landmine: "Landmine",
    claymore: "Claymore",
    rpg: "RPG", // Fired same as with other grenade launchers or shoulder mounts, so not sure if should be here,
    missile: "Missile",
    explosiveCharge: "Explocharge"
}

export let meleeAttackTypes = {
    melee: "Melee", // Regular melee bonk
    mono: "Mono", // Monokatanas, etc
    martial: "Martial", // Martial arts! Here, the chosen attack skill does not matter
    cyberbeast: "Beast"
}

// There's a lot of these, so here's a sorted one for convenience 
export let sortedAttackTypes = Object.values(rangedAttackTypes).concat(Object.values(meleeAttackTypes)).sort();

// These are preceded by Conceal, as for example, conceal Jacket is in fact supposed to show "Jacket/Coat/Shoulder Rig", so just "Jacket" doesn't make sense
export let concealability = {
    pocket: "ConcealPocket",
    jacket: "ConcealJacket",
    longcoat: "ConcealLongcoat",
    noHide: "ConcealNoHide"
}

export let availability = {
    excellent: "Excellent",
    common: "Common",
    poor: "Poor",
    rare: "Rare"
}

export let reliability = {
    very: "VeryReliable",
    standard: "Standard",
    unreliable: "Unreliable"
}

export let fireModes = {
    fullAuto: "FullAuto",
    threeRoundBurst: "ThreeRoundBurst",
    suppressive: "Suppressive",
    // Really semi auto is any none auto with RoF with more than 1
    semiAuto: "SemiAuto"
}

export let martialActions = {
    dodge: "Dodge",
    blockParry: "BlockParry",
    strike: "Strike",
    kick: "Kick",
    disarm: "Disarm",
    sweepTrip: "SweepTrip",
    grapple: "Grapple",
    hold: "Hold",
    choke: "Choke",
    throw: "Throw",
    escape: "Escape"
}

// Be warned that the localisations of these take a range parameter
export let ranges = {
    pointBlank: "RangePointBlank",
    close: "RangeClose",
    medium: "RangeMedium",
    long: "RangeLong",
    extreme: "RangeExtreme",
    auto: "RangeAuto"
}
let rangeDCs = {}
rangeDCs[ranges.pointBlank] = 10;
rangeDCs[ranges.close] = 15;
rangeDCs[ranges.medium] = 20;
rangeDCs[ranges.long] = 25;
rangeDCs[ranges.extreme] = 30;
let rangeResolve = {};
rangeResolve[ranges.pointBlank] = range => 1;
rangeResolve[ranges.close] = range => range/4;
rangeResolve[ranges.medium] = range => range/2;
rangeResolve[ranges.long] = range => range;
rangeResolve[ranges.extreme] = range => range*2;
export { rangeDCs, rangeResolve }

export function getMaxRangeBracketDistance(weaponRange, bracketName) {
    if (bracketName === ranges.pointBlank) return 2; // Fixed 2 meters for Point Blank based on discussion
    if (!rangeResolve[bracketName]) return Infinity;
    return rangeResolve[bracketName](weaponRange);
}

export function getRangeBracketForDistance(distance, weaponRange) {
    if (distance <= getMaxRangeBracketDistance(weaponRange, ranges.pointBlank)) return ranges.pointBlank;
    if (distance <= getMaxRangeBracketDistance(weaponRange, ranges.close)) return ranges.close;
    if (distance <= getMaxRangeBracketDistance(weaponRange, ranges.medium)) return ranges.medium;
    if (distance <= getMaxRangeBracketDistance(weaponRange, ranges.long)) return ranges.long;
    return ranges.extreme;
}

export let defaultTargetLocations = ["Head", "Torso", "lArm", "rArm", "lLeg", "rLeg"]
export let defaultAreaLookup = {
    1: "Head",
    2: "Torso",
    3: "Torso",
    4: "Torso",
    5: "rArm",
    6: "lArm",
    7: "lLeg",
    8: "lLeg",
    9: "rLeg",
    10: "rLeg"
}
export function defaultHitLocations() {
    const actorModel = game.model?.Actor;
    const hitLocs = actorModel?.templates?.hitLocations?.hitLocations || actorModel?.character?.hitLocations;
    if (hitLocs) return hitLocs;
    
    // Default fallback
    return {
        Head: { location: [1], stoppingPower: 0, ablation: 0},
        Torso: { location: [2, 4], stoppingPower: 0, ablation: 0},
        lArm: { location: [6], stoppingPower: 0, ablation: 0},
        rArm: { location: [5], stoppingPower: 0, ablation: 0},
        lLeg: { location: [7, 8], stoppingPower: 0, ablation: 0},
        rLeg: { location: [9, 10], stoppingPower: 0, ablation: 0}
    };
}

import { filterSupportedFireModes } from "./combat/settings-helpers.js";

export function rangedModifiers(weapon, targetTokens=[], context={}) {
    let range = weapon.system.range || 50;
    let rawFireModes = weapon.__getFireModes() || [];
    let fireModes = filterSupportedFireModes(rawFireModes, context);

    let defaultRange = "RangeClose";
    let rangeChoices = [
        {value:"RangePointBlank", localData: {range: 1}},
        {value:"RangeClose", localData: {range: range/4}},
        {value:"RangeMedium", localData: {range: range/2}},
        {value:"RangeLong", localData: {range: range}},
        {value:"RangeExtreme", localData: {range: range*2}}
    ];

    const targetsWithDistance = targetTokens.filter(t => t.distance?.value !== undefined && Number.isFinite(Number(t.distance.value)));
    
    if (targetsWithDistance.length > 1) {
        defaultRange = ranges.auto;
        rangeChoices.unshift({ value: ranges.auto });
    } else if (targetsWithDistance.length === 1) {
        defaultRange = getRangeBracketForDistance(Number(targetsWithDistance[0].distance.value), range);
    }

    return [
        [{
            localKey: "FireMode",
            dataPath: "fireMode",
            choices: fireModes,
            defaultValue: fireModes[0]
        },
        {
            localKey: "Range", 
            dataPath: "range", 
            defaultValue: defaultRange,
            choices: rangeChoices
         }],

         [{
            localKey: "Aiming",
            dataPath: "aimRounds",
            defaultValue: 0,
            choices: [0,1,2,3].map(x => {
                return { value: x, localKey: "Rounds", localData: {rounds: x}}
            }),
        },
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            // TODO: Have this dependent on target
            choices: defaultTargetLocations,
            allowBlank: true
        },
        {
            localKey: "TargetsCount",
            dataPath: "targetsCount",
            defaultValue: targetTokens.length,
            readOnly: targetTokens.length != 0,
        },
        {localKey:"Ambush", dataPath:"ambush",defaultValue: false},
        {localKey:"Blinded", dataPath:"blinded",defaultValue: false},
        {localKey:"DualWield", dataPath:"dualWield",defaultValue: false},
        {localKey:"FastDraw", dataPath:"fastDraw",defaultValue: false},
        {localKey:"Hipfire", dataPath:"hipfire",defaultValue: false},
        {localKey:"Ricochet", dataPath:"ricochet",defaultValue: false},
        {localKey:"Running", dataPath:"running",defaultValue: false},
        {localKey:"TurnFace", dataPath:"turningToFace",defaultValue: false},
        {localKey:"CoverSP", dataPath:"coverSp", defaultValue: 0}]
    ];
}

export function martialOptions(actor) {
    return [
        [{
            localKey: "Action",
            dataPath: "action",
            choices: [
                {groupName: "Defensive", choices: [
                    "Dodge",
                    "BlockParry"
                ]},
                {groupName: "Attacks", choices: [
                    "Strike",
                    "Kick",
                    "Disarm",
                    "SweepTrip"
                ]},
                {groupName: "Grapple", choices: [
                    "Grapple",
                    "Hold",
                    "Choke",
                    "Throw",
                    "Escape"
                ]}
            ]
        },
        {
            localKey: "MartialArt",
            dataPath: "martialArt",
            choices: [{value: "Brawling", localKey: "SkillBrawling"}, ...(actor.trainedMartials().map(martialName => {
                return {value: martialName, localKey: "Skill"+martialName}
            }))]
        }
    ]]
}

// Needs to be a function, or every time the modifiers dialog is launched, it'll add "extra mods" on
export function meleeBonkOptions() {
    return [[
        {
            localKey: "TargetArea",
            dataPath: "targetArea",
            defaultValue: "",
            // TODO: Have this dependent on target
            choices: defaultTargetLocations,
            allowBlank: true
        }
    ]]
}

/**
 * Get a body type modifier from the body type stat (body)
 * I couldn't figure out a single formula that'd work for it (cos of the weird widths of BT values)
 */
export function btmFromBT(body) {
    body = Math.floor(Number(body) || 0);
    if(body <= 2) {
        return 0;
      }
      switch(body) {
        // Weak
        case 3:
        case 4: return 1
        // Average
        case 5:
        case 6:
        case 7: return 2;
        // Strong
        case 8:
        case 9: return 3;
        // Very strong
        case 10: return 4;
        // Super strong
        case 11:
        case 12: return 5;
        // Extremely strong
        case 13:
        case 14: return 6;
        default: return 8;
      }
}

export function strengthDamageBonus(bt) {
    bt = Math.floor(Number(bt) || 0);
    let btm = btmFromBT(bt);
    if(btm < 5)
        return btm - 2;

    switch(bt) {
        case 11:
        case 12: return 4 
        case 13:
        case 14: return 5
        default: return 8
    }
}
