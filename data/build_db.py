#!/usr/bin/env python3
"""Build emigration.db from the UN DESA International Migrant Stock
"destination and origin" workbooks. Run from this directory:

    python -I build_db.py

Reads  raw/undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx  (primary)
       raw/undesa_pd_2020_ims_stock_by_sex_destination_and_origin.xlsx  (previous edition)
Writes emigration.db

Nothing is estimated or interpolated: every number is copied from Table 1
("both sexes combined" block) of a workbook. Rows are kept only where the
destination (or origin, for `immigrants`) is a country or area, i.e. the
workbook's data-type column is filled; regional and development-group
aggregates have no data type and are dropped. World totals come from the
workbook's own "World" destination row for origin Greece.

Why two editions: the 2024 edition only itemises the largest origins for
each destination and folds the rest into an "Others" row, so some real
Greek destinations (United Kingdom, France, New Zealand, ...) have no
Greece row there. The 2020 edition is itemised for every pair, so it is
loaded too as stock_rev2020 / totals_rev2020. Figures differ between
editions because the UN revises the series; do not mix them in one chart.
"""
import datetime
import os
import sqlite3
import sys

import openpyxl
import pycountry

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "emigration.db")
PAGE = "https://www.un.org/development/desa/pd/content/international-migrant-stock"
FILES = "https://www.un.org/development/desa/pd/sites/www.un.org.development.desa.pd/files/"
LICENSE = "CC BY 3.0 IGO (http://creativecommons.org/licenses/by/3.0/igo/)"
DOWNLOAD_DATE = "2026-10-27"

EDITIONS = {
    2024: dict(
        file="undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx",
        title=("United Nations Department of Economic and Social Affairs, Population Division (2024). "
               "International Migrant Stock 2024: Destination and origin (POP/DB/MIG/Stock/Rev.2024), "
               "Table 1: International migrant stock at mid-year by sex and by region, country or area "
               "of destination and origin, 1990-2024"),
        years=[1990, 1995, 2000, 2005, 2010, 2015, 2020, 2024],
        code_col=4, type_col=3,          # destination M49 code / data-type columns
    ),
    2020: dict(
        file="undesa_pd_2020_ims_stock_by_sex_destination_and_origin.xlsx",
        title=("United Nations Department of Economic and Social Affairs, Population Division (2020). "
               "International Migrant Stock 2020: Destination and origin (POP/DB/MIG/Stock/Rev.2020), "
               "Table 1: International migrant stock at mid-year by sex and by region, country or area "
               "of destination and origin, 1990-2020"),
        years=[1990, 1995, 2000, 2005, 2010, 2015, 2020],
        code_col=3, type_col=4,
    ),
}

GREECE = 300   # UN M49 code
WORLD = 900
ORIGIN_COL = 6
FIRST_VALUE_COL = 7      # "both sexes combined" block starts here
TOP_ORIGINS = 40

# Continent-level rows in the workbook are written in capitals; everything
# that follows one of them (until the next) belongs to that continent.
CONTINENTS = {
    "AFRICA": "Africa",
    "ASIA": "Asia",
    "EUROPE": "Europe",
    "LATIN AMERICA AND THE CARIBBEAN": "Latin America and the Caribbean",
    "NORTHERN AMERICA": "Northern America",
    "OCEANIA": "Oceania",
}

# Subregion rows that a workbook nevertheless gives a data type to.
NOT_COUNTRIES = {927}   # "Australia/New Zealand" subregion (2024 edition)

# M49 codes with no ISO 3166-1 alpha-2 code in pycountry.
ISO_OVERRIDES = {
    412: "XK",   # Kosovo (user-assigned code, widely used)
}


def m49_to_iso2(code):
    if code in ISO_OVERRIDES:
        return ISO_OVERRIDES[code]
    c = pycountry.countries.get(numeric="%03d" % code)
    return c.alpha_2 if c else None


def clean(name):
    return name.strip().rstrip("*").strip()


def load(edition):
    """Return (stock, totals, immigrants, countries) for one edition.
    stock rows: (year, iso2, dest, region, people); immigrants: (year, iso2, origin, people)."""
    e = EDITIONS[edition]
    path = os.path.join(HERE, "raw", e["file"])
    if not os.path.exists(path):
        print("skipping edition %d: missing %s" % (edition, path), file=sys.stderr)
        return None
    ws = openpyxl.load_workbook(path, read_only=True)["Table 1"]
    rows = ws.iter_rows(min_row=11, values_only=True)
    hdr = next(rows)
    years = e["years"]
    assert [int(y) for y in hdr[FIRST_VALUE_COL:FIRST_VALUE_COL + len(years)]] == years, hdr
    data = [r for r in rows if r[0] is not None]
    cc, tc = e["code_col"], e["type_col"]

    countries, region_of, current = {}, {}, None
    for r in data:
        name, dtype, code = r[1], r[tc], r[cc]
        if code in countries or code in region_of:
            continue
        key = clean(name).upper()
        if key in CONTINENTS:
            current = CONTINENTS[key]
            region_of[code] = None
            continue
        if dtype is None or code in NOT_COUNTRIES:
            region_of[code] = None      # aggregate / subregion
            continue
        countries[code] = clean(name)
        region_of[code] = current

    def values(r):
        return [None if v is None else int(v) for v in r[FIRST_VALUE_COL:FIRST_VALUE_COL + len(years)]]

    stock, totals, immigrants = [], [], []
    for r in data:
        dest, origin = r[cc], r[ORIGIN_COL]
        if origin == GREECE and dest == WORLD:
            totals += [(y, v) for y, v in zip(years, values(r)) if v is not None]
        if origin == GREECE and dest in countries:
            stock += [(y, m49_to_iso2(dest), countries[dest], region_of[dest], v)
                      for y, v in zip(years, values(r)) if v is not None]
        if dest == GREECE and origin in countries:
            immigrants += [(y, m49_to_iso2(origin), countries[origin], v)
                           for y, v in zip(years, values(r)) if v is not None]
    return stock, totals, immigrants, countries


def main():
    primary = load(2024)
    if primary is None:
        sys.exit("the 2024 edition is required")
    stock, totals, immigrants, countries = primary

    # keep only the top origins per year for the "who came to Greece" section
    keep = []
    for y in EDITIONS[2024]["years"]:
        keep += sorted((t for t in immigrants if t[0] == y), key=lambda t: -t[3])[:TOP_ORIGINS]
    immigrants = keep

    prev = load(2020)
    stock20, totals20 = (prev[0], prev[1]) if prev else ([], [])

    names = {}
    for t in stock20 + stock:            # 2024 spellings win
        names[t[1]] = t[2]
    for t in immigrants:
        names[t[1]] = t[2]
    names[m49_to_iso2(GREECE)] = countries[GREECE]
    country_rows = sorted(names.items(), key=lambda kv: kv[1])
    if None in names:
        print("no ISO alpha-2 for:", names[None], file=sys.stderr)

    if os.path.exists(OUT):
        os.remove(OUT)
    db = sqlite3.connect(OUT)
    db.executescript("""
        CREATE TABLE stock(year INTEGER, iso2 TEXT, dest TEXT, region TEXT, people INTEGER);
        CREATE TABLE totals(year INTEGER, people INTEGER);
        CREATE TABLE immigrants(year INTEGER, iso2 TEXT, origin TEXT, people INTEGER);
        CREATE TABLE stock_rev2020(year INTEGER, iso2 TEXT, dest TEXT, region TEXT, people INTEGER);
        CREATE TABLE totals_rev2020(year INTEGER, people INTEGER);
        CREATE TABLE countries(iso2 TEXT, name TEXT);
        CREATE TABLE meta(key TEXT, value TEXT);
    """)
    db.executemany("INSERT INTO stock VALUES (?,?,?,?,?)", stock)
    db.executemany("INSERT INTO totals VALUES (?,?)", totals)
    db.executemany("INSERT INTO immigrants VALUES (?,?,?,?)", immigrants)
    db.executemany("INSERT INTO stock_rev2020 VALUES (?,?,?,?,?)", stock20)
    db.executemany("INSERT INTO totals_rev2020 VALUES (?,?)", totals20)
    db.executemany("INSERT INTO countries VALUES (?,?)", country_rows)
    meta = [
        ("source", EDITIONS[2024]["title"]),
        ("source_url", FILES + EDITIONS[2024]["file"]),
        ("source_page", PAGE),
        ("edition", "International Migrant Stock 2024 (POP/DB/MIG/Stock/Rev.2024)"),
        ("license", LICENSE),
        ("downloaded", DOWNLOAD_DATE),
        ("built", datetime.date.today().isoformat()),
        ("origin", "Greece (M49 300, ISO GR)"),
        ("years", ",".join(map(str, EDITIONS[2024]["years"]))),
        ("measure", "International migrant stock at mid-year, both sexes combined"),
        ("stock_note", "destination countries/areas only; UN regional and development-group aggregates "
                       "dropped. The 2024 edition itemises only the largest origins per destination, so "
                       "destinations whose Greek-born population falls under 'Others' are absent."),
        ("immigrants_note", "top %d origin countries/areas per year of migrants living in Greece" % TOP_ORIGINS),
        ("region_note", "region = UN continent (Africa, Asia, Europe, Latin America and the Caribbean, "
                        "Northern America, Oceania)"),
    ]
    if prev:
        meta += [
            ("source_rev2020", EDITIONS[2020]["title"]),
            ("source_rev2020_url", FILES + EDITIONS[2020]["file"]),
            ("rev2020_note", "stock_rev2020/totals_rev2020 come from the 2020 edition, which itemises every "
                             "destination-origin pair; its figures are an earlier revision and differ from "
                             "the 2024 edition for the same years."),
        ]
    db.executemany("INSERT INTO meta VALUES (?,?)", meta)
    db.commit()
    db.execute("VACUUM")
    db.close()

    con = sqlite3.connect(OUT)
    for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        n = con.execute("SELECT count(*) FROM %s" % t).fetchone()[0]
        print("%-14s %6d rows" % (t, n))
    print("%s  %d bytes" % (OUT, os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
