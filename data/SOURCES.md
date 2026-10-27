# Data sources for emigration.db

Built by `build_db.py` (run from this directory: `python -I build_db.py`).
No figure is estimated, interpolated or adjusted; everything is copied from the
published workbooks below. Raw downloads live in `raw/` (about 12 MB in total,
keep them out of git).

## 1. UN DESA, International Migrant Stock 2024 — Destination and origin (primary)

* Title: United Nations Department of Economic and Social Affairs, Population
  Division (2024). *International Migrant Stock 2024: Destination and origin*,
  POP/DB/MIG/Stock/Rev.2024, Table 1 "International migrant stock at mid-year by
  sex and by region, country or area of destination and origin, 1990-2024".
* Landing page: https://www.un.org/development/desa/pd/content/international-migrant-stock
* File: https://www.un.org/development/desa/pd/sites/www.un.org.development.desa.pd/files/undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx
* Local copy: `raw/undesa_pd_2024_ims_stock_by_sex_destination_and_origin.xlsx` (6,005,287 bytes)
* Downloaded: 2026-10-27 (the UN site is behind CloudFront and refuses curl; the
  file was saved through the desktop browser and moved into `raw/`).
* Licence: CC BY 3.0 IGO.
* Taken: the "both sexes combined" block (1990, 1995, 2000, 2005, 2010, 2015,
  2020, 2024) of Table 1 for
  * origin = Greece (M49 300), destination = every country or area → `stock`
    (year, iso2, dest, region, people); the UN regional and development-group
    aggregate rows are dropped, and `region` is the UN continent heading the
    destination sits under in the workbook;
  * origin = Greece, destination = World → `totals` (year, people);
  * destination = Greece, origin = every country or area, top 40 per year →
    `immigrants` (year, iso2, origin, people).
* Known limitation: this edition itemises only the largest origins of each
  destination and folds the rest into an "Others" row. Destinations whose
  Greek-born population is in "Others" (notably the United Kingdom, France and
  New Zealand) therefore have **no** Greece row and are absent from `stock`.
  57 destinations have a Greece row.

## 2. UN DESA, International Migrant Stock 2020 — Destination and origin (previous edition)

* Title: United Nations Department of Economic and Social Affairs, Population
  Division (2020). *International Migrant Stock 2020: Destination and origin*,
  POP/DB/MIG/Stock/Rev.2020, Table 1 (1990-2020).
* File: https://www.un.org/development/desa/pd/sites/www.un.org.development.desa.pd/files/undesa_pd_2020_ims_stock_by_sex_destination_and_origin.xlsx
* Local copy: `raw/undesa_pd_2020_ims_stock_by_sex_destination_and_origin.xlsx` (6,370,150 bytes)
* Downloaded: 2026-10-27, same way as above.
* Taken: origin = Greece, destination = every country or area → `stock_rev2020`;
  origin = Greece, destination = World → `totals_rev2020`. Same column layout as
  the 2024 tables. This edition itemises every destination–origin pair (65
  destinations with a Greece row, including the UK and France).
* Caution: the two editions are different revisions of the series and disagree
  for the same year (e.g. Greek-born worldwide in 2020: 1,088,507 in the 2020
  edition vs 775,995 in the 2024 edition). Use one edition per chart and name it.

## Country codes

`iso2` is ISO 3166-1 alpha-2, mapped from the UN M49 numeric code with the
`pycountry` package; Kosovo (M49 412, not in ISO) is written as `XK`.
`countries(iso2, name)` lists every code used in the tables with the UN name
from the 2024 workbook (older spellings such as "Turkey" are replaced by the
newer "Türkiye" where both editions supply the same code).

## Not used

Nothing else. No other source was consulted for figures.
