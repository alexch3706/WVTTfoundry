#!/usr/bin/env python3
"""Build core-book Actor records from the owner's PDF, without bundling the PDF.

All numeric stat blocks, skill ranks, attack rows, abilities and loot come from
the printed tables. The explicit adaptations below cover the named variants,
table omissions, and runtime fields the book does not itself specify.
"""
import argparse
import copy
import hashlib
import html
import importlib.util
import json
import re
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = 'witcher-rilerena'
SOURCE = 'The Witcher Core Rulebook v1.35'
spec = importlib.util.spec_from_file_location('equipment_importer', Path(__file__).with_name('import-book.py'))
equipment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(equipment)
clean, norm = equipment.clean, equipment.key
SKILLS = {
    'Athletics': 'athletics', 'Awareness': 'awareness', 'Brawling': 'brawling',
    'Courage': 'courage', 'Crossbow': 'crossbow', 'Dodge/Escape': 'dodge',
    'Endurance': 'endurance', 'Resist Coercion': 'resistCoercion', 'Resist Magic': 'resistMagic',
    'Small Blades': 'smallBlades', 'Stealth': 'stealth', 'Swordsmanship': 'swordsmanship',
    'Wilderness Survival': 'wildernessSurvival', 'Wild. Survival': 'wildernessSurvival',
    'Hex Weaving': 'hexWeaving', 'Ritual Crafting': 'ritualCrafting', 'Spell Casting': 'spellCasting',
    'Staff/Spear': 'staffSpear', 'Archery': 'archery', 'Melee': 'melee', 'Physique': 'physique',
    'Intimidate': 'intimidation', 'Intimidation': 'intimidation', 'Deduction': 'deduction',
    'Persuasion': 'persuasion',
}
ENTRIES = [
    (271, 'Bandit', 'humanoid', True), (273, 'Mage', 'humanoid', True),
    (275, 'Scoia’tael Archer', 'humanoid', True), (277, 'Drowner', 'necrophage', True),
    (279, 'Ghoul', 'necrophage', False), (281, 'Grave Hag', 'necrophage', True),
    (283, 'Wraith', 'specter', True), (285, 'Noonwraith', 'specter', True),
    (287, 'Wolf', 'beast', False), (289, 'Werewolf', 'cursed', True),
    (291, 'Siren', 'hybrid', False), (293, 'Griffin', 'hybrid', False),
    (295, 'Endrega Worker', 'insectoid', False), (297, 'Arachas', 'insectoid', False),
    (299, 'Golem', 'elementa', True), (301, 'Fiend', 'relict', False),
    (303, 'Nekker', 'ogroid', True), (305, 'Rock Troll', 'ogroid', True),
    (307, 'Wyvern', 'draconid', False), (309, 'Katakan', 'vampire', False),
]
CATALOG = {}
for pack in ['weapons', 'armor', 'equipment', 'alchemy', 'components', 'witcher-gear']:
    for item in json.loads((ROOT / f'data/witcher/{pack}.json').read_text()):
        CATALOG[norm(item['name'])] = (pack, item)
ALIASES = {'throwingknives': 'throwingknife', 'arrows': 'standardammunition', 'bolts': 'standardammunition'}
ALIASES.update(dict(zip(
    ['drownerbrains', 'elvenburrowers', 'fiendeyes', 'ghoulclaws', 'griffinfeather', 'nekkerclaws', 'vampiesaliva', 'wraithessence'],
    ['drownerbrain', 'elvenburrowerammunition', 'fiendseye', 'ghoulclaw', 'griffinfeathers', 'nekkerclaw', 'vampiresaliva', 'essenceofwraith'])))
ACTORS, AUDIT = [], []


def identity(*parts):
    return hashlib.sha256(':'.join(map(str, ('core135', 'bestiary', *parts))).encode()).hexdigest()[:16]


def source_item(actor, name, kind, data, page):
    if kind == 'weapon' and data.get('properties', {}).get('natural'):
        data.setdefault('reliability', 0)
        data.setdefault('maxReliability', 0)
    return {'_id': identity(actor, kind, name), 'name': name, 'type': kind,
            'img': 'icons/svg/sword.svg' if kind == 'weapon' else 'icons/svg/shield.svg' if kind == 'armor' else 'icons/svg/book.svg',
            'system': {'quantity': 1, 'weight': 0, 'cost': 0, 'carried': False,
                       'source': SOURCE, 'page': page, **data}}


def tables(pdf, page):
    return [t.extract() for t in pdf.pages[page - 1].find_tables()]


def table(tables, header, required=True):
    matches = [t for t in tables if t[0][0] == header]
    if required and len(matches) != 1:
        raise ValueError(f'Expected one {header} table, got {len(matches)}')
    return matches[0] if matches else []


def rows(tables, header):
    return [cell for row in table(tables, header, False)[1:] for cell in row if cell]


def stat_block(tables):
    base = {k.lower(): int(v) for k, v in table(tables, 'INT')}
    derived = {k.lower(): int(v) if v != '-' else None for k, v in table(tables, 'STUN')}
    assert len(base) == 9 and len(derived) == 8
    return base, derived


def anatomy(humanoid, armor):
    entries = [
        ('head', 'Head', 'head', 1, 1, -6, 3),
        ('torso', 'Torso', 'torso', 2, 4 if humanoid else 5, -1, 1),
    ]
    if humanoid:
        entries += [('rightArm', 'Right arm', 'arm', 5, 5, -3, .5),
                    ('leftArm', 'Left arm', 'arm', 6, 6, -3, .5),
                    ('rightLeg', 'Right leg', 'leg', 7, 8, -2, .5),
                    ('leftLeg', 'Left leg', 'leg', 9, 10, -2, .5)]
    else:
        entries += [('rightLimb', 'Right limb', 'leg', 6, 7, -3, .5),
                    ('leftLimb', 'Left limb', 'leg', 8, 9, -3, .5),
                    ('tailWing', 'Tail / wing', 'arm', 10, 10, -2, .5)]
    return [dict(zip(['id', 'label', 'group', 'min', 'max', 'aim', 'multiplier'], entry), sp=armor, maxSp=armor) for entry in entries]


def ability(actor, cell, page, category='ability'):
    lines = cell.splitlines()
    name = lines.pop(0)
    if name == 'Invisible to Magical':
        name += ' ' + lines.pop(0)
    description = clean('\n'.join(lines))
    key = norm(name)
    return source_item(actor, clean(name), 'ability', {
        'category': category, 'effectText': description,
        'description': '<p>' + html.escape(description) + '</p>',
        'ability': {'key': key, 'mode': 'reference' if name in ['Spells', 'Rituals', 'Hexes'] else 'passive'},
    }, page)


def attack_item(actor, row, page, humanoid=False):
    name, damage, effect, rof = map(clean, row)
    if not re.fullmatch(r'\d+d\d+(?:[+/\-]\d+)?', damage):
        raise ValueError(f'{actor}/{name}: damage {damage!r}')
    base = CATALOG.get(ALIASES.get(norm(name), norm(name))) if humanoid else None
    data = copy.deepcopy(base[1]['system']) if base else {}
    props = {**data.get('properties', {}), **equipment.effects(effect), 'fixedDamage': True}
    if not humanoid:
        props['natural'] = True
    wa = re.search(r'WA\s*([+-]\d+)', effect)
    rng = re.search(r'RNG:\s*(\d+)m', effect)
    if 'Slow Loading' in effect:
        props['slowReload'] = True
    skill = data.get('skill', 'brawling' if name == 'Punch' else 'swordsmanship' if name == 'Wraith sword' else 'melee')
    dtype = 'bludgeoning' if name in ['Punch', 'Hooves', 'Wraith lantern'] else 'piercing' if re.search(r'Bite|Gore|Horns|barbs', name) else 'slashing'
    data.update(damage=damage, effectText=effect, properties=props,
                description='<p>' + html.escape(effect) + '</p>',
                rof=int(rof or 1), skill=skill, stat=data.get('stat', 'ref'),
                damageTypes=data.get('damageTypes', [dtype]), category=data.get('category', 'natural'),
                accuracy=int(wa[1]) if wa else data.get('accuracy', 0),
                range=int(rng[1]) if rng else data.get('range', 0),
                hands=data.get('hands', 0), equipped=True, carried=humanoid)
    if base:
        data['notes'] = f'Attack damage, accuracy, range and ROF follow the NPC stat block; equipment details: {base[1]["name"]}, p.{base[1]["system"]["page"]}. Damage already includes the stat-block bonus.'
    elif not humanoid:
        data['notes'] = 'Damage is the complete printed attack damage. Its physical damage type is assigned from the attack form; the bestiary attack table does not print damage types.'
    if not rof:
        data['notes'] = data.get('notes', '') + ' ROF is blank in this stat block; the standard crossbow ROF of 1 is used (p.73).'
    return source_item(actor, name, 'weapon', data, page)


def add_attack(actor, name, damage, skill='melee', range=0, properties=None, accuracy=0, page=None, rof=1):
    data = dict(damage=damage, skill=skill, stat='dex' if skill == 'athletics' else 'will' if skill == 'spellCasting' else 'ref',
                range=range, rof=rof, hands=0, equipped=True, category='naturalRanged' if range else 'natural',
                accuracy=accuracy, damageTypes=['bludgeoning'],
                properties={'natural': True, 'fixedDamage': True, **(properties or {})})
    actor['items'].append(source_item(actor['name'], name, 'weapon', data, page or actor['system']['page']))


def loot_entry(text):
    text = clean(text)
    match = re.fullmatch(r'(.+?)\s*\((\d+(?:d\d+)?(?:/\d+)?)\)', text)
    prefix = re.fullmatch(r'(\d+d\d+) (.+)', text)
    if match:
        name, quantity = match.groups()
    elif prefix:
        quantity, name = prefix.groups()
    elif re.fullmatch(r'\d+ (Crowns|Bolts)', text):
        quantity, name = text.split(' ', 1)
    else:
        name, quantity = text, '1'
    target = CATALOG.get(ALIASES.get(norm(name), norm(name)))
    return {'name': name, 'formula': quantity,
            'uuid': f'Compendium.{SYSTEM}.{target[0]}.Item.{target[1]["_id"]}' if target else '',
            'inInventory': False}


def apply_traits(actor):
    s, items = actor['system'], actor['items']
    traits = s['traits']
    abilities = {i['system']['ability']['key']: i for i in items if i['type'] == 'ability'}
    descriptions = ' '.join(i['system']['effectText'] for i in abilities.values())
    for key, item in abilities.items():
        text = item['system']['effectText']
        if key == 'feral':
            traits['feralInt'] = int(re.search(r'INT of (\d+)', text)[1])
        if key == 'regeneration':
            traits['regeneration'] = int(re.search(r'regenerates (\d+)', text)[1])
        if key == 'nightvision': traits['nightVision'] = True
        if key == 'amphibious': traits['amphibious'] = True
        if key == 'constructed':
            traits.update(infiniteStamina=True, mindless=True)
            s['immunities'] += ['bleeding', 'poison', 'fire']
            actor['prototypeToken']['bar2']['attribute'] = None
        if key == 'poisonimmunity': s['immunities'].append('poison')
        if key == 'impenetrablydim': traits['mindless'] = True
        if key == 'fueledbyrage': traits['unreasoning'] = True
        if key == 'resistances':
            s['naturalResistances'] += [x for x in ['piercing', 'slashing', 'bludgeoning', 'bleeding'] if x in text]
        if key == 'firevulnerability': s['vulnerabilities'].append('fire')
        if key == 'electricityvulnerability': s['vulnerabilities'].append('electricity')
        if key == 'crushingforce': traits['crushingForce'] = True
        if key == 'incorporeal': traits['alwaysIncorporeal'] = True
        if key == 'massivebulk': s['immunities'] += ['prone', 'knockback']
        if key == 'pounce': traits['pounce'] = True
        if key == 'scenttracking': traits['scentTracking'] = True
        if key == 'fury': traits.update(furyThreshold=10, furyRegeneration=3)
        if key == 'celestialweakness':
            if actor['name'] == 'Katakan': traits['sunlightRegeneration'] = 3
            if actor['name'] == 'Noonwraith': traits['moonlightPenalty'] = -2
        if key == 'sensitivehearing': traits['sensitiveHearing'] = True
        if key == 'limitedmovement': traits['landStats'] = 2
        if key == 'moondustbombs': traits['moondustStopsRegeneration'] = True
        if key == 'flight':
            threshold = re.search(r'more than (\d+) points', text)
            traits['flightDamageThreshold'] = int(threshold[1]) if threshold else 0
            speed = re.search(r'SPD of (\d+)', text)
            traits['flightSpeed'] = int(speed[1]) if speed else s['stats']['spd']
        if key in ['leader', 'skullcircle', 'camouflage', 'flight', 'swimming', 'invisibility', 'teleportation', 'sonicscreech', 'commandtheundead', 'hypnosis', 'highnoondance', 'illusion', 'telepathy', 'ambushspecialist', 'blindlystubborn']:
            item['system']['ability']['mode'] = 'action'
        if key == 'shift': item['system']['ability']['mode'] = 'defense'
    if traits.get('crushingForce'):
        for i in items:
            if i['type'] == 'weapon' and i['name'] == 'Punch':
                i['system']['properties'].update(cannotParry=True, wearMultiplier=2)
    if actor['name'] in ['Arachas', 'Rock Troll']:
        torso = next(l for l in s['locations'] if l['id'] == 'torso')
        torso.update(weakName='Back' if actor['name'] == 'Arachas' else 'Stomach',
                     weakSp=10 if actor['name'] == 'Arachas' else 5,
                     weakMaxSp=10 if actor['name'] == 'Arachas' else 5)
    if actor['name'] == 'Grave Hag':
        next(i for i in items if i['name'] == 'Tongue')['system']['properties']['severableTongue'] = True
    if actor['name'] in ['Griffin', 'Golem', 'Fiend', 'Ox']:
        charge = abilities.get('charge')
        if charge:
            add_attack(actor, 'Charge', '8d6' if actor['name'] == 'Ox' else '10d6', skill='brawling' if actor['name'] == 'Golem' else 'melee',
                       accuracy=-4, properties={'fullRound': actor['name'] != 'Fiend', 'knockback': 3 if actor['name'] == 'Ox' else 8, 'minimumDistance': 10})
            charge['system']['ability']['mode'] = 'attack'
    if actor['name'] == 'Arachas':
        add_attack(actor, 'Webbing', '0d6', 'athletics', 10, {'webbing': True, 'minimumDistance': 8})
        abilities['webbing']['system']['ability']['mode'] = 'attack'
    if actor['name'] == 'Rock Troll':
        add_attack(actor, 'Thrown Boulder', '5d6', 'athletics', 16)
        abilities['thrownboulders']['system']['ability']['mode'] = 'attack'
    if actor['name'] == 'Wyvern':
        add_attack(actor, 'Spit Venom', '3d6', 'athletics', 8, {'poison': 100})
        abilities['spitvenom']['system']['ability']['mode'] = 'attack'
    if actor['name'] == 'Noonwraith':
        add_attack(actor, 'Dust Devil', '0d6', 'spellCasting', 5, {'blindRounds': '1d6'})
        abilities['dustdevil']['system']['ability']['mode'] = 'attack'
    if actor['name'] in ['Wolf', 'Nekker']:
        abilities['leader']['system']['ability']['mode'] = 'passive'
        abilities['leader']['system']['notes'] = 'The aura is provided by a living Warg / Nekker Chieftain; select its followers on the leader’s sheet.'
    for key in ['immunities', 'vulnerabilities', 'naturalResistances']:
        s[key] = sorted(set(s[key]))


def make_actor(name, category, humanoid, stats_tables, detail_tables, pdfpage, detailpage):
    stats, derived = stat_block(stats_tables)
    armor = int(rows(stats_tables, 'Armor')[0])
    skills = {}
    for text in rows(detail_tables, 'Skills'):
        match = re.fullmatch(r'(.+?)\s*\+(\d+)', clean(text))
        if not match or match[1] not in SKILLS:
            raise ValueError(f'{name}: unknown skill {text!r}')
        skills[SKILLS[match[1]]] = int(match[2])
    ecology = dict(table(stats_tables, 'Height', False))
    bounty = rows(stats_tables, 'Bounty')
    system = {
        'source': SOURCE, 'page': pdfpage - 1, 'category': category,
        'race': 'other', 'stats': stats, 'skills': skills,
        'hp': {'value': derived['hp'], 'max': derived['hp']},
        'sta': {'value': derived['sta'] or 0, 'max': derived['sta'] or 0},
        'luck': {'value': stats['luck'], 'max': stats['luck']}, 'vigor': derived['vigor'],
        'overrides': {k: derived[k] or 0 for k in ['hp', 'sta', 'stun', 'rec', 'enc', 'run', 'leap']},
        'anatomy': 'humanoid' if humanoid else 'monster',
        'locations': anatomy(humanoid, 0 if category == 'humanoid' else armor),
        'silverVulnerable': category not in ['humanoid', 'beast'],
        'organless': category in ['elementa', 'specter'],
        'immunities': [], 'naturalResistances': [], 'vulnerabilities': [], 'traits': {},
        'bestiary': {'threat': clean(' '.join(rows(stats_tables, 'Threat'))),
                     'bounty': int(re.search(r'\d+', bounty[0])[0]) if bounty else 0,
                     **{k.lower(): clean(v) for k, v in ecology.items()},
                     'loot': [loot_entry(x) for x in rows(detail_tables, 'Loot')],
                     'published': derived, 'printedArmor': armor},
    }
    actor = {'_id': identity(name), 'name': name, 'type': 'npc' if category == 'humanoid' else 'monster',
             'img': 'icons/svg/mystery-man.svg' if category == 'humanoid' else 'icons/svg/pawprint.svg',
             'prototypeToken': {'name': name, 'actorLink': False, 'bar1': {'attribute': 'hp'}, 'bar2': {'attribute': 'sta'},
                                'texture': {'src': 'icons/svg/mystery-man.svg' if category == 'humanoid' else 'icons/svg/pawprint.svg'}},
             'system': system, 'items': [], 'effects': [],
             'flags': {SYSTEM: {'sourcePages': [pdfpage, detailpage]}}}
    for row in table(detail_tables, 'Weapons')[2:]:
        actor['items'].append(attack_item(name, row, detailpage - 1, category == 'humanoid'))
    for section in ['Abilities', 'Vulnerabilities']:
        cells = rows(detail_tables, section)
        # The Bird's abilities have an unruled header; pdfplumber finds the two data rows only.
        if name == 'Bird' and section == 'Abilities' and not cells:
            cells = next(t for t in detail_tables if t[0][0].startswith('Flight\n'))
            cells = [x[0] for x in cells]
        for cell in cells:
            if clean(cell) != 'NONE':
                actor['items'].append(ability(name, cell, detailpage - 1, 'ability' if section == 'Abilities' else 'vulnerability'))
    if category == 'humanoid':
        armor_items = []
        for loot in system['bestiary']['loot']:
            entry = CATALOG.get(ALIASES.get(norm(loot['name']), norm(loot['name'])))
            if entry and entry[1]['type'] == 'armor':
                item = copy.deepcopy(entry[1])
                item['_id'] = identity(name, 'armor', item['name'])
                item['system'].update(equipped=True)
                armor_items.append(item)
                loot['inInventory'] = True
            if norm(loot['name']) in ['bolts', 'arrows']:
                item = copy.deepcopy(CATALOG['standardammunition'][1])
                item['_id'] = identity(name, 'ammo', loot['name'])
                item['name'] = loot['name']
                item['system'].update(quantity=int(loot['formula']), carried=True)
                actor['items'].append(item)
                loot['inInventory'] = True
        if armor and not armor_items:
            armor_items.append(source_item(name, 'Armor (stat block)', 'armor', {
                'stoppingPower': armor, 'coverage': [l['id'] for l in system['locations']], 'equipped': True,
                'notes': 'The NPC stat block gives a uniform armor value but does not identify armor pieces, price, weight or EV.'
            }, pdfpage - 1))
        actor['items'] += armor_items
        weapons = [i for i in actor['items'] if i['type'] == 'weapon' and not i['system'].get('isAmmo')]
        ammo = next((i for i in actor['items'] if i['system'].get('isAmmo')), None)
        for i, item in enumerate(weapons):
            item['system']['equipped'] = i == 0
            if ammo and item['system']['category'] in ['bow', 'crossbow']:
                item['system']['ammoId'] = ammo['_id']
    apply_traits(actor)
    ACTORS.append(actor)
    return actor


def variant(base, name, pdfpage, variant_tables=None):
    actor = copy.deepcopy(base)
    actor.update(_id=identity(name), name=name)
    actor['prototypeToken']['name'] = name
    actor['system']['page'] = pdfpage - 1
    actor['flags'][SYSTEM]['sourcePages'] = sorted(set([*actor['flags'][SYSTEM]['sourcePages'], pdfpage]))
    actor['system']['notes'] = f'Variant of {base["name"]}; shared values follow that entry. Variant source: p.{pdfpage - 1}.'
    for item in actor['items']:
        item['_id'] = identity(name, item['type'], item['name'])
    if variant_tables:
        stats, derived = stat_block(variant_tables)
        actor['system']['stats'] = stats
        for key in ['hp', 'sta']:
            actor['system'][key] = {'value': derived[key], 'max': derived[key]}
        actor['system']['overrides'].update({k: derived[k] for k in ['hp', 'sta', 'stun', 'rec', 'enc', 'run', 'leap']})
        actor['system']['bestiary']['published'] = derived
    ACTORS.append(actor)
    return actor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pdf', type=Path)
    args = parser.parse_args()
    with pdfplumber.open(args.pdf) as pdf:
        by_name = {}
        for page, name, category, humanoid in ENTRIES:
            detail = tables(pdf, page + 1)
            actor = make_actor(name, category, humanoid, tables(pdf, page), detail, page, page + 1)
            by_name[name] = actor
            if name in ['Wolf', 'Nekker']:
                new = variant(actor, 'Warg' if name == 'Wolf' else 'Nekker Chieftain', page + 1, detail)
                next(i for i in new['items'] if i['type'] == 'ability' and i['name'] == 'Leader')['system']['ability']['mode'] = 'action'
            if name == 'Endrega Worker':
                subspecies = rows(detail, 'Sub-Species')
                actor['items'].append(ability(name, subspecies[2], page))
                next(i for i in actor['items'] if i['type'] == 'weapon')['system']['properties']['poison'] = 25
                for subtype, index in [('Warrior', 1), ('Drone', 0)]:
                    new = variant(actor, 'Endrega ' + subtype, page + 1)
                    new['items'] = [i for i in new['items'] if i['name'] != 'Worker’s Claws']
                    next(i for i in new['items'] if i['type'] == 'weapon')['system']['properties']['poison'] = 0
                    ab = ability(new['name'], subspecies[index], page)
                    ab['system']['ability']['mode'] = 'attack' if subtype == 'Warrior' else 'action'
                    new['items'].append(ab)
                    if subtype == 'Warrior': add_attack(new, 'Tail', '4d6+2', properties={'poison': 50})
        variant(by_name['Arachas'], 'Endrega Queen', 295)
        for page, names in [(311, ['Cat', 'Dog']), (312, ['Bird', 'Serpent']),
                            (313, ['Horse', 'War Horse']), (314, ['Ox', 'Mule']),
                            (322, ['“Crucible” Kowal', 'Lord Nowak'])]:
            all_tables = tables(pdf, page)
            split = [i for i, t in enumerate(all_tables) if t[0][0] == 'INT']
            assert len(split) == 2
            blocks = [all_tables[:split[1]], all_tables[split[1]:]]
            for name, block in zip(names, blocks):
                actor = make_actor(name, 'humanoid' if page == 322 else 'beast', page == 322, block, block, page, page)
                if name in ['Horse', 'War Horse', 'Ox', 'Mule']:
                    item = CATALOG[norm(name)][1]['system']['mount']
                    actor['system']['transport'] = {'control': item['control'], 'ramDamage': item['ramDamage']}
        woolabag = variant(by_name['Rock Troll'], 'Woolabag', 319)
        club_table = tables(pdf, 323)[0][1]
        club = source_item('Woolabag', 'Branch Club', 'weapon', {
            'category': 'bludgeon', 'skill': 'melee', 'stat': 'ref', 'damage': club_table[4],
            'damageTypes': ['bludgeoning'], 'accuracy': int(club_table[2]), 'rof': int(club_table[5]),
            'reliability': int(club_table[6]), 'maxReliability': int(club_table[6]), 'range': 2,
            'weight': int(club_table[11]), 'equipped': True, 'carried': True, 'hands': 2,
            'properties': {'longReach': True, 'stunWeapon': True, 'stun': -1},
            'effectText': clean(club_table[8]),
            'notes': 'The equipment table prints “+1 Stun”; the save threshold is reduced by 1, matching the core Stun weapon property. Woolabag has no separate Melee rank in his referenced Rock Troll block; no rank has been invented.'
        }, 322)
        woolabag['items'].append(club)
        woolabag['flags'][SYSTEM]['sourcePages'].append(323)
    for actor in ACTORS:
        actor['system']['biography'] = '<p>' + html.escape(f'{SOURCE}, p.{actor["system"]["page"]}.') + '</p>'
        AUDIT.append({'name': actor['name'], 'id': actor['_id'], 'pdfPages': actor['flags'][SYSTEM]['sourcePages'],
                      'attacks': [i['name'] for i in actor['items'] if i['type'] == 'weapon' and not i['system'].get('isAmmo')],
                      'abilities': [i['name'] for i in actor['items'] if i['type'] == 'ability']})
    assert len(ACTORS) == 36 and len({a['_id'] for a in ACTORS}) == 36
    destination = ROOT / 'data/witcher'
    (destination / 'bestiary.json').write_text(json.dumps(ACTORS, ensure_ascii=False, indent=2) + '\n')
    audit = {'sourceSha256': hashlib.sha256(args.pdf.read_bytes()).hexdigest(), 'count': len(ACTORS), 'rows': AUDIT,
             'adaptations': [
                 'Standard humanoid / nonhumanoid tables are assigned by body form (p.154); the book gives no species-specific d10 tables. The table and labels remain editable.',
                 'Natural attacks use the complete printed damage; their physical damage types are assigned by attack form because the bestiary table omits types.',
                 'Warg and Nekker Chieftain use their printed variant stats and the base entry’s skills, weapons and loot. Endrega Queen uses Arachas as directed on p.294.',
                 'Animal and NPC RUN / LEAP / REC differences from derived formulas are retained as explicit overrides.',
                 'Woolabag references the Rock Troll block and Branch Club. The source supplies no Melee rank for the club; none is invented.',
                 'Kowal’s Hand Crossbow has no printed ROF; standard crossbow ROF 1 is used.',
                 'Thrown Boulder and Spit Venom use Athletics as ranged attacks; their ability paragraphs do not specify an attack skill.',
                 'Bandit level suggestions offer variable REF/DEX and equipment; no single invented veteran stat block is emitted.',
                 'Magic spell, ritual and hex lists are references; player spell automation remains deferred.',
             ]}
    (destination / 'bestiary-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    print(f'{len(ACTORS)} actors; {sum(len(a["items"]) for a in ACTORS)} embedded items; source-linked audit written.')


if __name__ == '__main__':
    main()
