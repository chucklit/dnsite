#!/usr/bin/env python3
"""Builds pumpkins.db: the drawn cross-section (assets) and the data tables. Run from the repo root."""
import sqlite3, os, math, random, datetime
random.seed(7)
W, H = 760, 560
cx, cy = 320, 310
def seeds():
    out = []
    for i in range(46):
        a = random.uniform(0, 2 * math.pi); r = random.uniform(30, 118)
        x = cx + math.cos(a) * r * 1.15; y = cy + math.sin(a) * r * 0.95
        rot = random.uniform(-80, 80)
        out.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="9" ry="5.5" transform="rotate({rot:.0f} {x:.1f} {y:.1f})" fill="#f3e3b2" stroke="#8a6a2a" stroke-width="1"/>')
    return "\n".join(out)
def strands():
    out = []
    for i in range(14):
        a = i / 14 * 2 * math.pi; x1 = cx + math.cos(a) * 40; y1 = cy + math.sin(a) * 34; x2 = cx + math.cos(a) * 150; y2 = cy + math.sin(a) * 125
        mx = (x1 + x2) / 2 + math.cos(a + 1.2) * 18; my = (y1 + y2) / 2 + math.sin(a + 1.2) * 18
        out.append(f'<path d="M{x1:.0f} {y1:.0f} Q{mx:.0f} {my:.0f} {x2:.0f} {y2:.0f}" fill="none" stroke="#d9a21b" stroke-width="2.2" stroke-linecap="round" opacity=".85"/>')
    return "\n".join(out)
lab = lambda x, y, t, anchor="start": f'<text x="{x}" y="{y}" font-family="Futura, Avenir Next, Helvetica, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing=".06em" fill="#2a1d12" text-anchor="{anchor}">{t.upper()}</text>'
lead = lambda x1, y1, x2, y2: f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#2a1d12" stroke-width="1.2"/><circle cx="{x1}" cy="{y1}" r="3" fill="#2a1d12"/>'
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">
<title>Cross-section of a pumpkin</title>
<path d="M300 92 C298 70 306 48 318 36 C330 48 338 72 336 94 Z" fill="#6b7a3a" stroke="#3f4a22" stroke-width="2"/>
<path d="M310 60 L306 90 M326 58 L328 92" stroke="#3f4a22" stroke-width="1.2" fill="none"/>
<path d="M320 96 C390 96 470 110 500 170 C530 230 532 330 500 400 C470 470 400 500 320 500 C240 500 170 470 140 400 C108 330 110 230 140 170 C170 110 250 96 320 96 Z" fill="#e8841c" stroke="#a04e0c" stroke-width="4"/>
<path d="M258 104 C230 200 230 400 258 494 M382 104 C410 200 410 400 382 494 M200 130 C176 230 176 380 200 468 M440 130 C464 230 464 380 440 468" fill="none" stroke="#c46a12" stroke-width="2.5" opacity=".8"/>
<path d="M320 124 C380 124 450 136 476 190 C502 244 504 330 476 390 C450 450 388 472 320 472 C252 472 190 450 164 390 C136 330 138 244 164 190 C190 136 260 124 320 124 Z" fill="#f4a73c" stroke="#c46a12" stroke-width="2"/>
<ellipse cx="{cx}" cy="{cy}" rx="160" ry="135" fill="#f9d98a" stroke="#d9a21b" stroke-width="2"/>
{strands()}
{seeds()}
<ellipse cx="320" cy="500" rx="10" ry="4" fill="#6b4a1e"/>
{lead(318,60,470,40)}{lab(476,44,"stem (peduncle)")}
{lead(495,170,560,150)}{lab(566,154,"rind")}
{lead(466,250,560,236)}{lab(566,240,"flesh (mesocarp)")}
{lead(380,210,560,300)}{lab(566,304,"seed cavity")}
{lead(300,330,150,440)}{lab(146,444,"seeds",'end')}
{lead(250,250,150,210)}{lab(146,214,"fibrous strands",'end')}
{lead(200,300,150,330)}{lab(146,334,"ribs",'end')}
{lead(320,500,470,540)}{lab(476,544,"blossom end")}
</svg>'''
p = os.path.join(os.path.dirname(__file__), 'pumpkins.db')
if os.path.exists(p): os.remove(p)
c = sqlite3.connect(p)
c.execute('create table assets(name text primary key, type text, data blob)')
c.execute('insert into assets values(?,?,?)', ('cross_section', 'image/svg+xml', svg.encode()))
c.execute('create table psl(year int, month int, day int, doy int, note text)')
for y, m, d, n in [(2003,10,10,'first appeared, in about 100 stores'),(2004,9,1,'nationwide; exact day not recorded'),(2011,8,30,'early access'),(2012,8,31,'early access'),(2013,8,28,'early access'),(2014,8,26,'early access'),(2015,9,4,'early access'),(2016,9,1,'early access'),(2017,9,1,'early access'),(2018,8,28,''),(2019,8,27,''),(2020,8,25,''),(2021,8,24,''),(2022,8,30,''),(2023,8,24,''),(2024,8,22,''),(2025,8,26,'')]:
    c.execute('insert into psl values(?,?,?,?,?)', (y, m, d, datetime.date(y, m, d).timetuple().tm_yday, n))
c.execute('create table production(state text, iso text, million_lb real, acres int, year int)')
c.executemany('insert into production values(?,?,?,?,?)', [('Illinois','IL',485,15400,2024),('Indiana','IN',159.8,7100,2024),('California','CA',105.8,4700,2024),('Michigan','MI',104.6,5100,2024)])
c.execute('create table varieties(variety text, kind text, days_min int, days_max int, lb_min real, lb_max real)')
c.executemany('insert into varieties values(?,?,?,?,?,?)', [
 ('Jack Be Little','miniature',90,95,0.25,0.5),('Baby Boo','miniature, white',90,95,0.25,0.5),('Small Sugar (New England Pie)','pie',100,105,4,6),
 ("Jack O'Lantern",'carving',100,110,7,10),('Howden','carving',110,115,20,30),('Connecticut Field','carving / heirloom',110,120,15,25),
 ("Cinderella (Rouge vif d'Etampes)",'heirloom, flattened',110,115,15,20),("Dill's Atlantic Giant",'giant',120,130,100,400)])
c.execute('create table season(step int, when_ text, what text, note text)')
c.executemany('insert into season values(?,?,?,?)', [
 (1,'Late May – mid June','Sow','Direct-sow after the soil reaches about 65 °F; pumpkins hate cold feet'),
 (2,'June – July','Vines run','A hill can throw vines 15–20 ft; the first flowers are male'),
 (3,'July','Female flowers and fruit set','Look for the tiny pumpkin behind the flower; bees do the rest'),
 (4,'August','Sizing','Fruit swells fast; water deeply and keep leaves dry'),
 (5,'September','Colour and cure','Rind hardens and turns; cut with a few inches of stem, cure 10 days in the sun'),
 (6,'October','Harvest and sell','Most of the crop moves in the five weeks before Halloween'),
 (7,'November','Pie season','Canned pumpkin (mostly Dickinson squash from Illinois) carries Thanksgiving')])
c.execute('create table timeline(year int, event text, note text)')
c.executemany('insert into timeline values(?,?,?)', [
 (1929,"Libby's introduces canned pumpkin",'Grown and packed around Morton, Illinois, still the centre of the canning crop'),
 (1933,'Thomson & Taylor advertise a ready-mixed "Pumpkin Pie Spice"','Nine spices in one tin'),
 (1934,'McCormick & Company sells its pumpkin pie spice','The Baltimore spice house, founded 1889, makes the blend a household name; it is still made in Hunt Valley, Maryland'),
 (2003,'Starbucks tests the Pumpkin Spice Latte','About 100 stores, from October 10'),
 (2004,'PSL goes nationwide','The season starts in early September'),
 (2012,'53 pumpkin beers on the market, says Nielsen','65 a year later'),
 (2015,'Pumpkin beer volume peaks in IRI-tracked stores','About 8,800 barrels; it has slipped since, as Oktoberfest styles took the shelf'),
 (2024,'Earliest PSL yet: August 22','Ten weeks before Halloween')])
c.commit(); c.execute('vacuum'); c.close(); print(os.path.getsize(p))
