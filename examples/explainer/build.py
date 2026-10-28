#!/usr/bin/env python3
"""Builds explainer.db: the how-it-works diagram, measured loader sizes, a timeline and the demo-site table.
Run from the repo root: python3 examples/explainer/build.py"""
import sqlite3, os, gzip
F='font-family="-apple-system, Segoe UI, Inter, Helvetica, Arial, sans-serif"'
def box(x,y,w,h,title,sub,fill):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="#121212" stroke-width="2"/><text x="{x+w/2}" y="{y+30}" {F} font-size="14" font-weight="800" text-anchor="middle" fill="#121212">{title}</text><text x="{x+w/2}" y="{y+50}" {F} font-size="11.5" text-anchor="middle" fill="#444">{sub}</text>'
def arrow(x1,y1,x2,y2,label,dy=-8):
    mx,my=(x1+x2)/2,(y1+y2)/2
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#c00" stroke-width="2.5" marker-end="url(#a)"/><text x="{mx}" y="{my+dy}" {F} font-size="11" font-weight="700" text-anchor="middle" fill="#c00" paint-order="stroke" stroke="#fff" stroke-width="4" stroke-linejoin="round">{label}</text>'
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 330">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 Z" fill="#c00"/></marker></defs>
{box(20,40,150,70,"Your DNS zone","TXT records: the site","#fff3f3")}
{box(245,40,150,70,"Any resolver","caches the records","#f4f4f4")}
{box(470,40,150,70,"Visitor's browser","asks DNS, renders","#f4f4f4")}
{box(470,230,150,70,"The loader","one static page, no data","#eef3ff")}
{arrow(172,75,242,75,"publish",-10)}
{arrow(397,75,467,75,"DNS over HTTPS",-10)}
<line x1="545" y1="112" x2="545" y2="226" stroke="#c00" stroke-width="2.5" marker-end="url(#a)"/>
<text x="535" y="165" {F} font-size="11" font-weight="700" text-anchor="end" fill="#c00">fetched once,</text>
<text x="535" y="179" {F} font-size="11" font-weight="700" text-anchor="end" fill="#c00">then cached</text>
<text x="20" y="160" {F} font-size="12.5" fill="#333">1. You put the site in TXT records at your registrar.</text>
<text x="20" y="182" {F} font-size="12.5" fill="#333">2. The domain points at a loader (a CNAME).</text>
<text x="20" y="204" {F} font-size="12.5" fill="#333">3. The browser reads the records and draws the page.</text>
<text x="20" y="248" {F} font-size="12.5" font-weight="700" fill="#121212">Nothing about your site is stored on a server.</text>
<text x="20" y="270" {F} font-size="12.5" font-weight="700" fill="#121212">The loader never sees it until a visitor asks.</text>
</svg>'''
p=os.path.join(os.path.dirname(__file__),'explainer.db')
if os.path.exists(p): os.remove(p)
c=sqlite3.connect(p)
c.execute('create table assets(name text primary key, type text, data blob)')
c.execute('insert into assets values(?,?,?)',('how','image/svg+xml',svg.encode()))
c.execute('create table loader(part text, raw int, gz int, when_needed text)')
for f,label,when in [('loader/index.html','Page and styles','always'),('loader/site.css','Styles and six themes','always'),('loader/app.js','Loader: 15 chart types, maps, parser','always'),('loader/assets/world.svg','World map','map charts'),('loader/vendor/temml.min.js','Equations (Temml)','math'),('loader/vendor/sql-wasm.js','SQLite glue','a database'),('loader/vendor/sql-wasm.wasm','SQLite engine (WebAssembly)','a database')]:
    d=open(f,'rb').read(); c.execute('insert into loader values(?,?,?,?)',(label,len(d),len(gzip.compress(d,9)),when))
c.execute('create table history(year int, event text, note text)')
c.executemany('insert into history values(?,?,?)',[
 (1983,'The Domain Name System is specified','RFC 882 and 883: names map to addresses, and a few other record types'),
 (1993,'TXT records get a job','RFC 1464 proposes storing arbitrary text attributes in DNS'),
 (2006,'SPF moves mail policy into TXT records','Every mail domain starts carrying text that software reads'),
 (2018,'DNS over HTTPS','RFC 8484 lets a web page ask a resolver directly, from JavaScript'),
 (2019,'SQLite compiled to WebAssembly','A full database engine runs inside the browser'),
 (2026,'DNSite','Text, data and vector art in TXT records; a static loader draws the site')])
c.execute('create table sites(name text, host text, kind text, records int, kb real, what text)')
c.executemany('insert into sites values(?,?,?,?,?,?)',[
 ('DNSite','dnsite.org','project page',9,6.9,'this explainer, charts and all'),
 ('Where the Greeks went','greeks.dnsite.org','data story',30,27.1,'456-row database, flow maps, sliders'),
 ('Pumpkin Patch Notes','pumpkins.dnsite.org','blog',12,10.2,'three posts, a drawn diagram, five tables'),
 ('Migrant-stock revisions','paper.dnsite.org','research note',30,28.4,'equations, numbered figures, references, footnotes')])
c.execute('create table fits(kind text, fits int, why text)')
c.executemany('insert into fits values(?,?,?)',[
 ('A blog or newsletter archive',1,'text is nearly free: about 3 records per 1,000 words'),
 ('A data story with charts and maps',1,'the numbers travel as a small SQLite file'),
 ('A research note or preprint',1,'equations, numbered figures, references and the data to reproduce them'),
 ('A menu, programme, directory or price list',1,'small tables, queried in the browser'),
 ('A portfolio reel',1,'embeds from YouTube, Vimeo, Bandcamp or Apple Music cost a line each'),
 ('A photo gallery',0,'photos are big; link them from a host you already have instead'),
 ('Anything visitors write to',0,'only the domain owner can change DNS')])
c.commit(); c.execute('vacuum'); c.close(); print(os.path.getsize(p))
