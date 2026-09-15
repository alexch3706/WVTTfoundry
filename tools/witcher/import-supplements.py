#!/usr/bin/env python3
"""Import the owner's A Witcher's Tools and A Witcher's Journal equipment.

Usage: python import-supplements.py TOOLS.pdf JOURNAL.pdf [--output-dir DIR]
Requires pdfplumber. The source PDFs remain outside the repository. Every
published table row is checked and has a stable ID and page/table/row citation.
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
SYSTEM = "witcher-rilerena"
TOOLS = "A Witcher’s Tools"
JOURNAL = "A Witcher’s Journal"
SCHOOLS = {
    "Ursine": "bear",
    "Feline": "cat",
    "Griffin": "griffin",
    "Manticore": "manticore",
    "Serpentine": "viper",
    "Viper’s": "viper",
    "Wolven": "wolf",
}
PERKS = {
    "Ursine Armor": "criticalDecimation",
    "Feline Armor": "criticalFlurry",
    "Griffin Armor": "criticalSpellcasting",
    "Manticore Armor": "criticalBlock",
    "Serpentine Armor": "criticalRiposte",
    "Wolven Armor": "criticalMomentum",
}
BODY_COVERAGE = ["torso", "rightArm", "leftArm", "rightLeg", "leftLeg"]
ALIASES = {
    "beastbone": "beastbones",
    "arachaseye": "arachaseyes",
    "wyverneye": "wyverneyes",
    "rottfiendblood": "rotfiendblood",
    "hagear": "gravehagear",
}
EXPECTED_UNRESOLVED = {
    ("Feline Silver Sword Diagram", "Ruby Dust"),
    ("Serpentine Silver Sword Diagram", "Emerald Dust"),
}


def clean(value):
    return re.sub(r"\s+", " ", (value or "").replace("-\n", "").replace("\u00ad", "")).strip()


def key(value):
    return re.sub(r"[^a-z0-9]", "", clean(value).lower())


def number(value):
    value = clean(value)
    if not re.fullmatch(r"[+-]?(?:\d*\.)?\d+", value):
        raise ValueError(f"Expected a number, got {value!r}")
    return float(value) if "." in value else int(value)


def school(name):
    for prefix, result in SCHOOLS.items():
        if name.startswith(prefix):
            return result
    raise ValueError(f"Unknown Witcher school in {name!r}")


def properties(text):
    out = {}
    for label, field in [
        ("Armor Piercing", "armorPiercing"),
        ("Improved Armor Piercing", "improvedArmorPiercing"),
        ("Meteorite", "meteorite"),
        ("Ablating", "ablating"),
        ("Balanced", "balanced"),
        ("Slow Reload", "slowReload"),
        ("Parrying", "parrying"),
    ]:
        if label in text:
            out[field] = True
    for label, field in [("Bleed", "bleeding"), ("Poison", "poison")]:
        match = re.search(label + r"\s*\((\d+)%\)", text)
        if match:
            out[field] = int(match[1])
    match = re.search(r"Silver\s*\(([^)]+)\)", text)
    if match:
        out.update(silver=True, silverDamage=match[1])
    match = re.search(r"Focus\s*\((\d+)\)", text)
    if match:
        out["focus"] = int(match[1])
    return out


def materials(text):
    # Serpentine Armor prints "Linen (4)" without the x; both forms are quantities.
    found = []
    for part in clean(text).split(","):
        if not part.strip():
            continue
        match = re.fullmatch(r"\s*(.*?)\s*\((?:x\s*)?(\d+)\)\s*", part)
        if not match:
            raise ValueError(f"Unparsed ingredient: {part!r}")
        found.append({"name": clean(match[1]), "quantity": int(match[2]), "uuid": ""})
    return found


class Importer:
    def __init__(self):
        self.packs = {"supplement-tools": [], "supplement-journal": []}
        self.audit = {"sources": [], "counts": {}, "rows": [], "aliases": [], "unresolved": []}

    def emit(self, pack, kind, name, data, book, page, table, row, cells):
        identity = f"{book}:{page}:{table}:{row}:{name}"
        record_id = hashlib.sha256(identity.encode()).hexdigest()[:16]
        system = {
            "quantity": 1,
            "weight": 0,
            "cost": 0,
            "carried": True,
            "equipped": False,
            **data,
            "source": book,
            # Tools prints the PDF page number; Journal has a one-page cover offset.
            "page": page if book == TOOLS else page - 1,
        }
        if system.get("effectText"):
            system["description"] = "<p>" + html.escape(system["effectText"]) + "</p>"
        record = {
            "_id": record_id,
            "name": name,
            "type": kind,
            "img": "icons/svg/sword.svg" if kind == "weapon" else "icons/svg/shield.svg" if kind in {"armor", "shield"} else "icons/svg/item-bag.svg",
            "system": system,
            "flags": {
                SYSTEM: {
                    "sourceRow": {"book": book, "pdfPage": page, "table": table, "row": row},
                }
            },
        }
        if book == TOOLS:
            system["priceText"] = "No market price is provided in the source."
            record["flags"][SYSTEM]["sourceOmissions"] = ["marketPrice"]
            record["flags"][SYSTEM]["recognizableWitcherGear"] = kind in {"weapon", "shield", "armor"}
        self.packs[pack].append(record)
        self.audit["rows"].append({
            "source": book, "pdfPage": page, "table": table, "row": row,
            "pack": pack, "id": record_id, "name": name, "cells": cells,
        })
        return record

    def source(self, path, title, pages):
        self.audit["sources"].append({
            "title": title, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "tablePdfPages": pages,
        })

    def tools(self, path):
        pages = [3, 4, 5, 6, 7]
        self.source(path, TOOLS, pages)
        with pdfplumber.open(path) as pdf:
            for page_no in pages:
                for ti, table in enumerate(pdf.pages[page_no - 1].find_tables()):
                    rows = table.extract()
                    header = [clean(c) for c in rows[0]]
                    for ri, raw in enumerate(rows[1:], 1):
                        row = [clean(c) for c in raw]
                        name = row[0]
                        data = {"school": school(name)}
                        if header[0] == "Weapon":
                            if len(row) != 11:
                                raise ValueError(f"Unexpected weapon row: {row}")
                            name, dtype, wa, damage, hands, rel, rng, effect, conc, en, weight = row
                            shield = name == "Manticore Shield"
                            category = "shield" if shield else "crossbow" if "Crossbow" in name else "smallBlade" if name == "Viper’s Fang" else "sword"
                            data.update({
                                "category": category,
                                "skill": {"shield": "melee", "crossbow": "crossbow", "smallBlade": "smallBlades", "sword": "swordsmanship"}[category],
                                "stat": "dex" if category == "crossbow" else "ref",
                                "damageTypes": [t for letter, t in [("P", "piercing"), ("S", "slashing"), ("B", "bludgeoning")] if letter in dtype],
                                "accuracy": number(wa), "damage": "@shieldDamage" if shield else damage,
                                "hands": number(hands), "reliability": number(rel), "maxReliability": number(rel),
                                "range": 0 if rng == "Melee" else number(rng.removesuffix("m")),
                                "effectText": effect, "properties": properties(effect),
                                "concealment": conc, "enhancements": 1 if shield else number(en),
                                "weight": number(weight), "witcherWeapon": True,
                            })
                            if shield:
                                data.update(armorClass="medium", ev=number(en), notes="Damage uses the Core Rulebook p.164 medium shield attack: lethal Punch damage two BODY-table levels higher. Silver damage is added only against a silver-vulnerable target.")
                            self.emit("supplement-tools", "shield" if shield else "weapon", name, data, TOOLS, page_no, ti, ri, row)
                        elif header[0] == "Armor":
                            if len(row) != 8:
                                raise ValueError(f"Unexpected armor row: {row}")
                            name, level, sp, en, effect, locations, ev, weight = row
                            if locations != "Torso, Arms, Legs":
                                raise ValueError(f"Unexpected school armor coverage: {locations}")
                            data.update({
                                "armorClass": level.lower(), "stoppingPower": number(sp),
                                "sp": {loc: number(sp) for loc in BODY_COVERAGE},
                                "coverage": BODY_COVERAGE, "enhancements": number(en),
                                "effectText": effect, "ev": number(ev), "weight": number(weight),
                                "ability": {"key": PERKS[name], "mode": "equipment"},
                            })
                            self.emit("supplement-tools", "armor", name, data, TOOLS, page_no, ti, ri, row)
                        elif header == ["Name", "Crafting DC", "Time", "Components", "Investment"]:
                            name, dc, time, parts, investment = row
                            data.update({
                                "skill": "crafting", "craftDC": number(dc), "craftTime": time,
                                "craftLevel": "master", "availability": "R", "investment": number(investment),
                                "materials": materials(parts), "productName": name, "productQuantity": 1,
                                "notes": parts,
                            })
                            self.emit("supplement-tools", "diagram", name + " Diagram", data, TOOLS, page_no, ti, ri, row)
                        else:
                            raise ValueError(f"Unrecognized Tools table {page_no}/{ti}: {header}")
        counts = collections.Counter(i["type"] for i in self.packs["supplement-tools"])
        if counts != {"weapon": 16, "shield": 1, "armor": 6, "diagram": 23}:
            raise ValueError(f"Incomplete Tools extraction: {counts}")

    def journal(self, path):
        pages = [143, 144, 145]
        self.source(path, JOURNAL, pages)
        with pdfplumber.open(path) as pdf:
            for page_no in pages:
                for ti, table in enumerate(pdf.pages[page_no - 1].find_tables()):
                    rows = table.extract()
                    header = [clean(c) for c in rows[0]]
                    color = ""
                    for ri, raw in enumerate(rows[1:], 1):
                        row = [clean(c) for c in raw]
                        if page_no == 145:
                            if row[0].endswith(" Mutagens") and not any(row[1:]):
                                color = row[0].split()[0].lower()
                                continue
                            name, effect, dc, mutation = row
                            match = re.fullmatch(r"\+(\d+) (Melee Damage|HP|REF|BODY|WILL|Vigor Threshold)", effect)
                            if not match or not color:
                                raise ValueError(f"Unknown mutagen effect: {row}")
                            field = {"Melee Damage": "meleeBonus", "HP": "hp", "REF": "ref", "BODY": "body", "WILL": "will", "Vigor Threshold": "vigor"}[match[2]]
                            record = self.emit("supplement-journal", "alchemical", name + " Mutagen", {
                                "category": "mutagen", "effectText": effect, "craftDC": number(dc),
                                "consumable": True, "bonuses": {field: int(match[1])},
                                "notes": mutation, "priceText": "No weight or market price is provided in the source.",
                            }, JOURNAL, page_no, ti, ri, row)
                            record["flags"][SYSTEM].update(mutagenColor=color, sourceOmissions=["weight", "marketPrice"])
                        elif header == ["Name", "Source", "Weight", "Cost"]:
                            name, origin, weight, cost = row
                            record = self.emit("supplement-journal", "component", name, {
                                "category": "hide", "weight": number(weight), "cost": number(cost),
                                "forageLocation": origin,
                                "effectText": "Animal hides and pelts can replace cow hide when making leather (A Witcher’s Journal p.142).",
                            }, JOURNAL, page_no, ti, ri, row)
                            record["flags"][SYSTEM]["leatherSource"] = True
                        elif header == ["Name", "Substance", "Symbol", "Source", "Weight", "Cost"]:
                            name, substance, symbol, origin, weight, cost = row
                            record = self.emit("supplement-journal", "component", name, {
                                "category": "alchemical", "substance": substance, "substanceUnits": 1,
                                "weight": number(weight), "cost": number(cost), "forageLocation": origin,
                            }, JOURNAL, page_no, ti, ri, row)
                            if name == "Burdok Root":
                                record["system"].update(availability="P", forageDC=16, forageQuantity="1d6", notes="Foraging: fields and forests; Poor rarity; DC 16; success yields 1d6 units (p.142).")
                            if name == "Crystallized Essence":
                                record["system"].update({
                                    "ability": {"key": "crushEssence", "mode": "processing"},
                                    "skill": "crafting", "craftDC": 10, "craftTime": "15 Minutes",
                                    "productName": "Infused Dust", "productQuantity": 2,
                                    "effectText": "Spend 15 minutes and pass a DC 10 Crafting check to destroy one unit of Crystallized Essence and create two units of Infused Dust.",
                                    "materials": [{"name": name, "quantity": 1, "uuid": ""}],
                                })
                                record["system"]["description"] = "<p>" + html.escape(record["system"]["effectText"]) + "</p>"
                        else:
                            raise ValueError(f"Unrecognized Journal table {page_no}/{ti}: {header}")
        counts = collections.Counter(i["type"] for i in self.packs["supplement-journal"])
        if counts != {"component": 73, "alchemical": 17}:
            raise ValueError(f"Incomplete Journal extraction: {counts}")

    def link(self):
        index = {}
        for pack in ["weapons", "armor", "equipment", "alchemy", "components", "witcher-gear", "relics"]:
            for item in json.loads((ROOT / "data" / "witcher" / f"{pack}.json").read_text()):
                index[key(item["name"])] = (pack, item)
        for pack, items in self.packs.items():
            for item in items:
                if item["type"] != "diagram":
                    index[key(item["name"])] = (pack, item)

        def link_to(name):
            canonical = ALIASES.get(key(name), key(name))
            target = index.get(canonical)
            return (f"Compendium.{SYSTEM}.{target[0]}.Item.{target[1]['_id']}", target[1]["name"]) if target else ("", "")

        for items in self.packs.values():
            for item in items:
                data = item["system"]
                if data.get("productName"):
                    data["productUuid"], canonical = link_to(data["productName"])
                    if not data["productUuid"]:
                        raise ValueError(f"Missing product {data['productName']}")
                for ingredient in data.get("materials", []):
                    ingredient["uuid"], canonical = link_to(ingredient["name"])
                    if not ingredient["uuid"]:
                        self.audit["unresolved"].append({"diagram": item["name"], "material": ingredient["name"]})
                    elif canonical != ingredient["name"]:
                        self.audit["aliases"].append({"diagram": item["name"], "printed": ingredient["name"], "canonical": canonical})
        found = {(u["diagram"], u["material"]) for u in self.audit["unresolved"]}
        if found != EXPECTED_UNRESOLVED:
            raise ValueError(f"Unexpected unresolved ingredients: {found}")

    def write(self, target):
        target.mkdir(parents=True, exist_ok=True)
        for pack, items in self.packs.items():
            self.audit["counts"][pack] = len(items)
            (target / f"{pack}.json").write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n")
        (target / "supplement-source-audit.json").write_text(json.dumps(self.audit, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"counts": self.audit["counts"], "unresolved": self.audit["unresolved"]}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tools_pdf", type=Path)
    parser.add_argument("journal_pdf", type=Path)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data" / "witcher")
    args = parser.parse_args()
    importer = Importer()
    importer.tools(args.tools_pdf)
    importer.journal(args.journal_pdf)
    importer.link()
    importer.write(args.output_dir)


if __name__ == "__main__":
    main()
