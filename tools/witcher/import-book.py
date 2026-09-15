#!/usr/bin/env python3
"""Import mechanical tables from the owner's Core Rulebook v1.35 PDF.

Requires pdfplumber. The PDF stays outside the repository. Every emitted row
records its source table and row; graphical alchemy ingredients are decoded
from their image fingerprints, independently of the PDF's text layer.
"""
import argparse
import collections
import hashlib
import html
import json
import re
from pathlib import Path
import pdfplumber

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = 'witcher-rilerena'
SUBSTANCES = ['Vitriol', 'Rebis', 'Aether', 'Quebrith', 'Hydragenum', 'Vermilion', 'Sol', 'Caelum', 'Fulgur']
SYMBOLS = dict(zip(['bb1df4a6e3f1', 'af878c9eb4cf', 'ffcb821f74d6', '0931cc032b0d', 'ad366838fbaa', '7c60409c21ce', '314757f6fd6a', '029cd5ed7858', '41a0d9b57c61'], SUBSTANCES))
ALL_LOC = ['head', 'torso', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg']
CATEGORIES = {'Swords': ('sword', 'swordsmanship'), 'Small Blades': ('smallBlade', 'smallBlades'), 'Axes': ('axe', 'melee'), 'Bludgeons': ('bludgeon', 'melee'), 'Pole Arms': ('polearm', 'staffSpear'), 'Staves': ('staff', 'staffSpear'), 'Thrown Weapons': ('thrown', 'athletics'), 'Bows': ('bow', 'archery'), 'Crossbows': ('crossbow', 'crossbow')}
PACKS = collections.defaultdict(list)
AUDIT = []
IGNORED = []

def clean(value):
    return re.sub(r'\s+', ' ', (value or '').replace('-\n', '').replace('\u00ad', '')).strip()

def number(value, default=0):
    value = clean(str(value)).replace(',', '')
    return float(value) if re.fullmatch(r'[+-]?(?:\d*\.)?\d+', value) else default

def key(value):
    return re.sub(r'[^a-z0-9]', '', clean(value).lower().replace('wive’s', 'wives’').replace('dimeritum', 'dimeritium').replace('relict oils', 'relict oil').replace('sulphur', 'sulfur').replace('ginitia', 'ginatia').replace('optima mater', 'optima matter'))

def effects(text):
    result = {}
    text = clean(text)
    for label, field in [('Armor Piercing', 'armorPiercing'), ('Improved Armor Piercing', 'improvedArmorPiercing'), ('Ablating', 'ablating'), ('Balanced', 'balanced'), ('Meteorite', 'meteorite'), ('Concealment', 'concealment'), ('Long Reach', 'longReach'), ('Grappling', 'grappling'), ('Brawling', 'brawling'), ('Slow Reload', 'slowReload'), ('Non-Lethal', 'nonlethal'), ('Restricted Vision', 'restrictedVision'), ('Full Cover', 'fullCover'), ('Greater Focus', 'greaterFocus')]:
        if label.lower() in text.lower(): result[field] = True
    for label, field in [('Bleed(?:ing)?', 'bleeding'), ('Poison', 'poison'), ('Fire', 'fire'), ('Freeze', 'freeze'), ('Stagger', 'stagger')]:
        m = re.search(label + r'\s*\((\d+)%\)', text, re.I)
        if m: result[field] = int(m[1])
    m = re.search(r'Stun\s*\((-?\d+)\)', text)
    if m: result['stun'] = -abs(int(m[1])); result['stunWeapon'] = True
    m = re.search(r'(?<!Greater )Focus\s*\((\d+)\)', text)
    if m: result['focus'] = int(m[1])
    m = re.search(r'Silver\s*\(([^)]+)\)', text)
    if m: result.update(silver=True, silverDamage=m[1])
    m = re.search(r'Balanced\s*\(\+(\d+)\)', text)
    if m: result['balancedBonus'] = int(m[1])
    return result

def types(text):
    return [name for letter, name in [('S', 'slashing'), ('P', 'piercing'), ('B', 'bludgeoning'), ('E', 'elemental')] if letter in text]

def coverage(text):
    groups = [('Head', ['head']), ('Torso', ['torso']), ('Arms', ['rightArm', 'leftArm']), ('Legs', ['rightLeg', 'leftLeg'])]
    return [loc for label, locs in groups if label.lower() in text.lower() for loc in locs]

def emit(pack, item_type, name, data, page, table, row):
    identity = f'core135:{page}:{table}:{row}:{pack}:{name}'
    item_id = hashlib.sha256(identity.encode()).hexdigest()[:16]
    data = {'quantity': 1, 'weight': 0, 'cost': 0, 'carried': True, 'equipped': False, **data, 'source': 'The Witcher Core Rulebook v1.35', 'page': page - 1}
    if 'effectText' in data:
        data['properties'] = {**effects(data['effectText']), **data.get('properties', {})}
        data['description'] = '<p>' + html.escape(data['effectText']) + '</p>'
        text = data['effectText']
        resistances = data.setdefault('resistances', [])
        for dtype in ['Piercing','Bludgeoning','Slashing','Poison','Bleeding','Fire']:
            if dtype + ' Resistance' in text and dtype.lower() not in resistances: resistances.append(dtype.lower())
        hp = re.search(r'\+(\d+) Health Points', text)
        if hp: data['bonuses'] = {'hp': int(hp[1])}
        skill_names = {'Seduction':'seduction','Charisma':'charisma','Courage':'courage','Resist Magic':'resistMagic','Spell Casting':'spellCasting','Hex Weaving':'hexWeaving','Disguise':'disguise','Business':'business','Wilderness Survival':'wildernessSurvival'}
        for label, skill in skill_names.items():
            match = re.search(r'\+(\d+) '+label, text)
            if match:
                condition = 'fishing' if name == 'Fishing Gear' else 'appraising goods' if name == 'Merchant’s Tools' else ''
                data.setdefault('skillBonuses', []).append({'skill': skill, 'value': int(match[1]), 'condition': condition})
        if name == 'Makeup Kit': data['skillBonuses'].append({'skill':'charisma','value':2,'condition':''})
        if name == 'Red Death': data['skillBonuses'].append({'skill':'resistMagic','value':3,'condition':''})
    record = {'_id': item_id, 'name': name, 'type': item_type, 'img': 'icons/svg/sword.svg' if item_type == 'weapon' else 'icons/svg/shield.svg' if item_type in ['armor', 'shield'] else 'icons/svg/item-bag.svg', 'system': data, 'flags': {SYSTEM: {'sourceRow': {'pdfPage': page, 'table': table, 'row': row}}}}
    PACKS[pack].append(record)
    AUDIT.append({'pdfPage': page, 'table': table, 'row': row, 'pack': pack, 'id': item_id, 'name': name})
    return record

def ingredients(text):
    return [{'name': clean(m[1]).lstrip(', '), 'quantity': int(m[2]), 'uuid': ''} for m in re.finditer(r'([^()]+?)\s*\(x\s*(\d+)\)', clean(text))]

def weapon(row, category):
    name, dtype, wa, avail, damage, rel, hands, rng, effect, conc, en, weight, cost = row
    cat, skill = CATEGORIES[category]
    if name == 'Brass Knuckles': skill = 'brawling'
    body_range = re.search(r'Body\s*x(\d+)', rng, re.I)
    return {'category': cat, 'skill': skill, 'stat': 'dex' if cat in ['bow', 'crossbow', 'thrown'] else 'ref', 'damageTypes': types(dtype), 'accuracy': number(wa), 'availability': avail, 'damage': damage, 'reliability': number(rel), 'maxReliability': number(rel), 'hands': number(hands), 'range': number(rng.replace('m', '')), 'rangeBodyMultiplier': int(body_range[1]) if body_range else 0, 'effectText': effect, 'concealment': conc, 'enhancements': number(en), 'weight': number(weight), 'cost': number(cost)}

def recipe(row, level, skill, page, table, idx, symbols=None):
    if len(row) == 6: name, dc, time, parts, investment, cost = row
    elif len(row) == 5: name, dc, time, parts, cost = row; investment = '0'
    else: name, dc, time, parts = row; cost = investment = '0'
    materials = ingredients(parts)
    if symbols:
        materials += [{'name': name, 'quantity': count, 'uuid': '', 'substance': name} for name, count in collections.Counter(symbols).items()]
    suffix = ' Formula' if skill == 'alchemy' else ' Diagram'
    out = emit('diagrams', 'diagram', name + suffix, {'skill': skill, 'craftDC': number(dc), 'craftTime': time, 'craftLevel': level, 'investment': number(investment), 'cost': number(cost), 'materials': materials, 'productName': name, 'productQuantity': int(re.search(r'\(x(\d+)\)', name)[1]) if re.search(r'\(x(\d+)\)', name) else 1, 'notes': parts}, page, table, idx)
    return out

def graphic_ingredients(page, found_table, row_index):
    row = found_table.rows[row_index]
    cells = [c for c in row.cells if c]
    y0, y1 = min(c[1] for c in cells), max(c[3] for c in cells)
    out = []
    for img in page.images:
        if 10 < img['width'] < 30 and found_table.bbox[0] < img['x0'] < found_table.bbox[2] and y0 <= (img['top'] + img['bottom']) / 2 < y1:
            fingerprint = hashlib.sha256(img['stream'].get_data()).hexdigest()[:12]
            if fingerprint not in SYMBOLS: raise ValueError(f'Unknown ingredient symbol {fingerprint}')
            out.append(SYMBOLS[fingerprint])
    return out

def import_pdf(path):
    pages = [74,75,80,81,84,85,88,89,91,92,93,94,*range(129,141),*range(144,149),248,249,250,251,252,255,256,257,*range(258,267)]
    with pdfplumber.open(path) as pdf:
        for page_no in pages:
            page = pdf.pages[page_no - 1]
            for ti, table in enumerate(page.find_tables()):
                rows = table.extract(); category = ''; level = ''
                for ri, raw in enumerate(rows):
                    row = [clean(c) for c in raw]
                    if not row[0]: continue
                    if row[0] in ['Name', 'Quality', 'Mutagen Source', 'Resistance', 'Type', 'Stopping Power']: continue
                    if all(not c for c in row[1:]):
                        category = row[0]
                        if 'Diagrams' in category or 'Formulae' in category: level = category.split()[0].lower()
                        continue
                    name = row[0]
                    if page_no in [74,75,84] and len(row) == 13:
                        emit('weapons', 'weapon', name, weapon(row, category), page_no, ti, ri)
                    elif (page_no == 75 and ti == 1) or (page_no == 85 and ti == 0):
                        name, dtype, avail, rel, effect, conc, weight, cost = row
                        amount = int(re.search(r'x(\d+)', name)[1])
                        emit('weapons', 'gear', re.sub(r'\s*\(x\d+\)', '', name) + ' Ammunition', {'isAmmo': True, 'ammoCategory': 'projectile', 'quantity': amount, 'damageTypes': types(dtype), 'availability': avail, 'reliability': number(rel), 'effectText': effect, 'concealment': conc, 'weight': number(weight) / amount, 'cost': number(cost) / amount, 'properties': {'burrower': 'Burrower' in name}}, page_no, ti, ri)
                    elif page_no in [80,81,85]:
                        kind = category.split()[0].lower()
                        if 'Shield' in category:
                            name, rel, avail, effect, ev, weight, cost = row
                            data = {'category': 'shield', 'armorClass': kind, 'reliability': number(rel), 'maxReliability': number(rel), 'availability': avail, 'effectText': effect, 'ev': number(ev), 'weight': number(weight), 'cost': number(cost), 'skill': 'melee', 'hands': 1}
                            if name == 'Nilfgaardian Pavise': data['properties'] = {'selfStanding': True}
                            if name == 'Mahakaman Pavise': data['properties'] = {'parrying': True}
                            emit('armor', 'shield', name, data, page_no, ti, ri)
                        else:
                            if len(row) == 9: name, sp, avail, en, effect, cover, ev, weight, cost = row; locations = coverage(cover)
                            else:
                                name, sp, avail, en, effect, ev, weight, cost = row
                                locations = ['head'] if page_no == 80 and ti == 0 else ['torso', 'rightArm', 'leftArm'] if page_no == 80 else ['rightLeg', 'leftLeg']
                            emit('armor', 'armor', name, {'armorClass': kind, 'stoppingPower': number(sp), 'availability': avail, 'enhancements': number(en), 'effectText': effect, 'coverage': locations, 'ev': number(ev), 'weight': number(weight), 'cost': number(cost)}, page_no, ti, ri)
                    elif page_no in [88,89]:
                        name, avail, effect, weight, cost = row
                        emit('alchemy', 'alchemical', name, {'availability': avail, 'effectText': effect, 'weight': number(weight), 'cost': number(cost), 'consumable': True, 'category': 'alchemical'}, page_no, ti, ri)
                    elif page_no == 91 and ti == 0:
                        name, effect, sp, b, s, p, avail, weight, cost = row
                        resistance = [name for value, name in [(b,'bludgeoning'),(s,'slashing'),(p,'piercing')] if value == 'X']
                        if 'Fire Resistance' in effect: resistance.append('fire')
                        if 'Bleed Resistance' in effect: resistance.append('bleeding')
                        emit('equipment', 'enhancement', name + ' Enhancement', {'category': 'armor', 'effectText': effect, 'stoppingPower': number(sp), 'resistances': resistance, 'availability': avail, 'weight': number(weight), 'cost': number(cost), 'skillBonuses': [{'skill': 'stealth', 'value': 1, 'condition': ''}] if name == 'Elven' else []}, page_no, ti, ri)
                    elif page_no == 91: continue
                    elif page_no == 92 and ti == 0:
                        name, athletics, control, speed, hp, weight, cost = row
                        ram = {'Carriage':4,'Cart':3,'Cutter':5,'Horse':3,'Mule':2,'Ox':4,'Sailing Boat':2,'Sailing Ship':4,'War Horse':4}[name]
                        emit('equipment', 'mount', name, {'category': 'vehicle' if athletics == 'N/A' else 'animal', 'mount': {'athletics': number(athletics), 'control': number(control), 'speed': number(speed), 'speedModifier': number(speed.split()[-1]) if 'Animal' in speed else 0, 'hp': number(hp), 'maxHp': number(hp), 'ramDamage': f'{ram}d6'}, 'weight': number(weight), 'cost': number(cost), 'carried': False}, page_no, ti, ri)
                    elif page_no in [92,93]:
                        if page_no == 93: name, avail, effect, conc, weight, cost = row
                        else: name, avail, effect, weight, cost = row; conc = ''
                        emit('equipment', 'gear', name, {'category': 'tool' if page_no == 93 else 'horseGear', 'availability': avail, 'effectText': effect, 'concealment': conc, 'weight': number(weight), 'cost': number(cost)}, page_no, ti, ri)
                    elif page_no == 94:
                        name, *rest = row; weight, cost = rest if len(rest) == 2 else ('0', rest[0])
                        emit('equipment', 'gear', name, {'category': ['general','container','service','food','lodging','clothing'][ti], 'weight': number(weight), 'cost': number(cost), 'priceText': cost, 'carried': ti not in [2,4]}, page_no, ti, ri)
                    elif page_no in [129,130,144,145,146]:
                        name, rarity, location, amount, dc, weight, cost = row
                        substance = SUBSTANCES[(page_no - 144) * 3 + ti] if page_no >= 144 else ''
                        emit('components', 'component', name, {'availability': rarity, 'forageLocation': location, 'forageQuantity': amount, 'forageDC': number(dc), 'weight': number(weight), 'cost': number(cost), 'substance': substance, 'category': 'alchemy' if substance else 'crafting'}, page_no, ti, ri)
                    elif 131 <= page_no <= 140:
                        recipe(row, level, 'crafting', page_no, ti, ri)
                    elif page_no in [147,148]:
                        syms = graphic_ingredients(page, table, ri)
                        if not syms: raise ValueError(f'Missing graphical recipe {name}')
                        recipe(row, level, 'alchemy', page_no, ti, ri, syms)
                    elif page_no == 248 and ti == 0:
                        name, dtype, wa, damage, hands, rel, effect, conc, en, weight = row
                        emit('weapons', 'weapon', name, weapon([name,dtype,wa,'R',damage,rel,hands,'N/A',effect,conc,en,weight,'0'], 'Swords'), page_no, ti, ri)
                    elif page_no == 248:
                        name, effect, duration, toxicity = row
                        duration_rounds = number(duration.split()[0]) if 'Rounds' in duration else 2400 if '2 Hours' in duration else 600 if 'Hour' in duration else 0
                        emit('witcher-gear', 'alchemical', name, {'category': 'potion', 'effectText': effect, 'duration': duration_rounds, 'toxicity': number(toxicity.replace('%','')), 'consumable': True, 'weight': .5}, page_no, ti, ri)
                    elif page_no == 249:
                        name, effect = row
                        emit('witcher-gear', 'alchemical', name + (' Decoction' if ti == 1 else ''), {'category': 'decoction' if ti == 1 else 'oil', 'effectText': effect, 'duration': 600, 'toxicity': 75 if ti == 1 else 0, 'consumable': True, 'weight': .5}, page_no, ti, ri)
                    elif page_no in [250,251]:
                        syms = graphic_ingredients(page, table, ri)
                        if page_no == 250 and ti < 2:
                            out = recipe([*row, '0'], '', 'crafting', page_no, ti, ri)
                        else:
                            if not syms: raise ValueError(f'Missing graphical recipe {name}')
                            out = recipe(row, '', 'alchemy', page_no, ti, ri, syms)
                            if page_no == 251:
                                if ti == 0: out['system']['materials'].append({'name': 'Dog Tallow', 'quantity': 1, 'uuid': ''})
                                else:
                                    out['system']['productName'] += ' Decoction'
                                    out['system']['materials'] += [{'name': name + ' Mutagen', 'quantity': 1, 'uuid': ''}, {'name': 'Spirits', 'quantity': 1, 'uuid': ''}]
                    elif page_no == 252:
                        name, effect, dc, mutation = row
                        emit('witcher-gear', 'alchemical', name + ' Mutagen', {'category': 'mutagen', 'effectText': effect, 'craftDC': number(dc), 'notes': mutation, 'consumable': True}, page_no, ti, ri)
                    elif page_no == 255:
                        name, dtype, radius, damage, effect, cost = row
                        emit('weapons', 'weapon', name, {'category': 'bomb' if ti == 0 else 'trap', 'skill': 'athletics' if ti == 0 else 'trapCrafting', 'stat': 'dex' if ti == 0 else 'cra', 'damageTypes': types(dtype), 'damage': damage if damage != 'N/A' else '0', 'rangeBodyMultiplier': 4 if ti == 0 else 0, 'consumable': True, 'weight': 1 if ti == 0 else 2, 'effectText': effect, 'cost': number(cost), 'properties': {'area': number(radius.replace('m','')), 'allLocations': True}}, page_no, ti, ri)
                    elif page_no == 256 and ti == 0:
                        name, dtype, effect, cost = row
                        emit('weapons', 'gear', name + ' Ammunition', {'isAmmo': True, 'ammoCategory': 'projectile', 'weight': .1, 'damageTypes': types(dtype), 'effectText': effect, 'cost': number(cost)}, page_no, ti, ri)
                    elif page_no == 256:
                        name, dc, parts, investment = row
                        out = recipe([name, dc, '1/2 Hour', parts, investment, '0'], '', 'crafting', page_no, ti, ri)
                        if ti == 3: out['system']['productName'] = re.sub(r'\s*\(x\d+\)', '', name) + ' Ammunition'
                    elif page_no == 257:
                        name, effect, weight, cost = row
                        emit('witcher-gear', 'enhancement', name, {'category': 'rune' if ti == 0 else 'glyph', 'effectText': effect, 'weight': number(weight), 'cost': number(cost)}, page_no, ti, ri)
                    elif 258 <= page_no <= 266:
                        # Relic tables include a lore paragraph as a merged final row.
                        if ri != 1: continue
                        preceding = page.crop((0,max(0,table.bbox[1]-35),page.width,table.bbox[1])).extract_text() or ''
                        title = preceding.splitlines()[-1]
                        name = title.split(' (')[0].strip()
                        if page_no <= 264:
                            dtype, wa, damage, rel, hands, rng, effect, conc, en, weight = row
                            cat = 'Small Blades' if 'Dagger' in title else 'Crossbows' if 'Crossbow' in title else 'Bows' if 'Bow)' in title else 'Pole Arms' if any(v in title for v in ['Halberd','Polearm','Spear']) else 'Staves' if 'Staff' in title else 'Axes' if 'Axe' in title else 'Bludgeons' if any(v in title for v in ['Warhammer','Mace']) else 'Swords'
                            data = weapon([name,dtype,wa,'R',damage,rel,hands,rng,effect,conc,en,weight,'0'], cat)
                            data['relic'] = True
                            emit('relics', 'weapon', name, data, page_no, ti, ri)
                        else:
                            sp, en, effect, cover, ev, weight = row
                            emit('relics', 'armor', name, {'relic': True, 'armorClass': 'light' if 'Light Armor' in title else 'medium' if 'Medium Armor' in title else 'heavy', 'stoppingPower': number(sp), 'enhancements': number(en), 'effectText': effect, 'coverage': coverage(cover), 'ev': number(ev), 'weight': number(weight)}, page_no, ti, ri)
                    else:
                        raise ValueError(f'Unclassified table row {page_no}:{ti}:{ri} {row}')
    emit('witcher-gear', 'gear', 'Witcher’s Medallion', {'category': 'witcher', 'effectText': 'Vibrates near active magic and monsters; crafting requires a mage and attunement at a Place of Power (p.249).'}, 250, 0, 1)
    # Pure substances can be recovered after a failed alchemy attempt (p.142).
    for i, name in enumerate(SUBSTANCES):
        emit('components', 'component', name, {'substance': name, 'category': 'pureSubstance', 'weight': .1}, 143, -1, i)

def link_recipes():
    index = {}
    for pack, items in PACKS.items():
        if pack == 'diagrams': continue
        for item in items:
            index[key(item['name'])] = (pack, item)
    aliases = {'witchersteelsword':'witcherssteelsword', 'witchersilversword':'witcherssilversword', 'trollmutagen':'rocktrollmutagen', 'tanningherb':'tanningherbs', 'mahkamansteel':'mahakamansteel', 'ammunitionblunt':'bluntammunition', 'ammunitionstandard':'standardammunition', 'ammunitionbodkin':'bodkinammunition', 'ammunitionbroadhead':'broadheadammunition', 'orions':'orion', 'throwingaxes':'throwingaxe', 'throwingknives':'throwingknife', 'spectaclehelm':'spectacledhelm', 'dwarvenimpact':'dwarvenimpactammunition', 'elvenburrower':'elvenburrowerammunition'}
    unresolved = []
    for item in PACKS['diagrams']:
        data = item['system']
        product = re.sub(r'\s*\(x\d+\)', '', data['productName'])
        k = key(product)
        match = index.get(k) or index.get(key(product + ' Enhancement')) or index.get(aliases.get(k,''))
        if match:
            pack, target = match; data['productUuid'] = f'Compendium.{SYSTEM}.{pack}.Item.{target["_id"]}'
        else: unresolved.append({'diagram': item['name'], 'product': product})
        for material in data['materials']:
            k = key(material['name']); match = index.get(k) or index.get(aliases.get(k,''))
            if match:
                pack, target = match; material['uuid'] = f'Compendium.{SYSTEM}.{pack}.Item.{target["_id"]}'
            elif not material.get('substance'): unresolved.append({'diagram': item['name'], 'material': material['name']})
    return unresolved

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('pdf', type=Path); args = parser.parse_args()
    import_pdf(args.pdf)
    unresolved = link_recipes()
    output = ROOT / 'data' / 'witcher'; output.mkdir(parents=True, exist_ok=True)
    for pack, items in PACKS.items():
        ids = [i['_id'] for i in items]
        assert len(ids) == len(set(ids)), f'Duplicate IDs in {pack}'
        (output / f'{pack}.json').write_text(json.dumps(items,ensure_ascii=False,indent=2)+'\n')
    report = {'sourceSha256': hashlib.sha256(args.pdf.read_bytes()).hexdigest(), 'counts': {p:len(v) for p,v in PACKS.items()}, 'rows': AUDIT, 'unresolved': unresolved}
    (output/'source-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'counts': report['counts'], 'unresolved': unresolved},ensure_ascii=False,indent=2))

if __name__ == '__main__': main()
