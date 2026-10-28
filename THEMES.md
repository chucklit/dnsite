# Themes, and running your own loader

A theme is CSS keyed on `[data-theme="name"]` in `loader/site.css`. The loader ships six:
`paper`, `ink`, `slate`, `journal`, `newsroom`, `fieldnotes`. A site picks one with `theme: name`.

Themes are deliberately **not** stored in DNS: a stylesheet served to strangers' readers could
phone home (`url(…)`, `@import`). Sites customise with tokens (`accent:`), and anything beyond
that lives in a loader, where the person running it is the person writing the CSS.

## Running your own loader

```bash
git clone https://github.com/chucklit/dnsite && cd dnsite/loader
# add your theme to site.css (below), then host this folder anywhere static:
wrangler pages deploy . --project-name my-loader        # or GitHub Pages, Netlify, a VPS…
```

Point a domain at it with a CNAME (an A record for a bare domain) and give it a certificate for
that name. Its records in DNS are unchanged; only the renderer differs. A site that uses a theme
your loader lacks falls back to `paper`, and a `key:` line the loader doesn't know is shown as
plain text, so sites stay readable when they move between loaders.

Keep the **format** (`SPEC.md`) and the **block types** as they are: those are the shared language,
and a site that relies on a private block only works on one loader. Add themes freely.

## Writing a theme

Everything is driven by custom properties on `[data-theme="…"]`; set those first, then override
specific elements only where the defaults don't fit. Minimal theme:

```css
[data-theme="mine"]{
  --bg:#fffdf7; --ink:#1a1a1a; --muted:#666; --rule:#e5e0d6; --card:#fff;   /* page, text, secondary text, hairlines, figure cards */
  --accent:#0b7285; --accent-ink:#fff;                                       /* links, bars, buttons */
  --c1:#0b7285; --c2:#e8590c; --c3:#2b8a3e; --c4:#862e9c;                    /* chart series (c1–c8) */
  --serif:"Charter",Georgia,serif; --sans:"Inter",system-ui,sans-serif; --mono:ui-monospace,monospace;
  --measure:44rem;                                                           /* reading column width */
}
```

The slots a theme usually touches (all scoped under `[data-theme="mine"]`):

| Slot | Selector | Notes |
|---|---|---|
| page | `body`, `.dnsite-root` | font, size, line height, background texture |
| title block | `header.site h1`, `.tagline`, `.byline` | the byline is a good place for a "stamp" |
| headings | `h2`, `h3` | sections and subsections |
| paragraphs | `p` | drop caps: `header.site+section>p:first-of-type::first-letter` |
| figure cards | `figure`, `figure figcaption`, `figure button` | charts, tables, images, embeds all live in `figure` |
| chart marks | `.bar`, `.series`, `.dot`, `.grid line`, `.lbl`, `.axis text` | keep `.lbl` readable on your card colour |
| maps | `.map path.land`, `.map .arc`, `.map .node` | |
| posts | `section.post header`, `ol.posts` | blog index and post headers |
| quote | `blockquote.pull`, `blockquote.pull cite` | |
| paper blocks | `.abstract`, `.authors`, `.math`, `ol.references`, `ol.footnotes`, `.figno` | |
| footer | `footer.site` | |

Rules of thumb: respect `prefers-reduced-motion` (the loader already does); keep contrast at
WCAG AA; don't hide the footer (it says where the site comes from); test at phone width.
`examples/` has a site for each shipped theme to compare against.

## Proposing a theme for the shared loader

Open a pull request adding it to `site.css` and `THEMES` in `app.js`, with an example site in
`examples/`. The shared loader stays small on purpose, so a theme should be distinct from the six
already there and useful to many sites, not one.
