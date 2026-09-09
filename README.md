# Perez Chapel International — Ghana Branch Directory

A premium, mobile-first church branch discovery platform. Search 90+ PCI
branches across Ghana by branch, pastor, city or region; view them on a map;
and get directions, call, or share in a tap.

Live site: https://pcibranches.netlify.app/

## Project structure

```
pci-branch-directory/
├── index.html        # Page structure, header/nav, hero, sections, SEO/OG/JSON-LD
├── style.css         # Full design system (navy + gold), responsive, motion-safe
├── app.js            # All logic: data, search, filters, map, near-me, URL state
├── data/
│   └── branches.csv  # The single source of truth for every branch
└── photos/           # Branch images referenced by the photo_url column
```

Everything runs as static files — **no build step, no framework, no npm install.**
It uses two CDN libraries loaded in `index.html`: Leaflet (map) and PapaParse (CSV).

## Run it locally

Because `app.js` fetches `data/branches.csv`, open it through a local server
(not by double-clicking the file, which blocks the fetch):

```bash
# from inside this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, VS Code "Live Server", etc.).

## Editing branch data

Open `data/branches.csv` in Excel, Google Sheets, or a text editor. Columns:

| column        | notes                                                        |
|---------------|--------------------------------------------------------------|
| region        | Ghana region (e.g. GREATER ACCRA)                            |
| branch_name   | Branch name                                                  |
| address       | Area / city / location text                                  |
| email         | Contact email                                                |
| phone         | Contact phone (local 0XX… format is fine)                   |
| pastor        | Pastor / leader (use `N/A` if unknown — shown gracefully)   |
| status        | `active`, `growing`, or `needs-support`                     |
| latitude      | Decimal degrees (enables map + distance)                    |
| longitude     | Decimal degrees                                              |
| year_founded  | Year established                                             |
| photo_url     | Path to image, e.g. `photos/EJURA.JPG` (leave blank if none)|

Stats, region counts, filter dropdowns and the map all regenerate
automatically from this file — nothing is hard-coded. Add a row, save,
redeploy, and the new branch appears everywhere.

> To add fields later (e.g. service times), add a column here and surface it in
> `app.js` (see `normalize()` and the `openDrawer()` detail groups). Coordinates
> can be added to any branch that lacks them and the map/near-me light up for it.

## Deploy to Netlify

Replace `index.html`, `style.css`, `app.js` (and `data/branches.csv` if changed)
in your repo, commit, and push — Netlify redeploys automatically. Or drag this
whole folder onto the Netlify dashboard for a manual deploy.

## Shareable URLs

The page reads and writes its state to the URL, so any search/filter is linkable:

- `?search=accra`
- `?region=GREATER%20ACCRA`
- `?status=active`
- `?b=<branch-id>` — opens that branch's detail view directly

## Accessibility & performance

Semantic HTML, keyboard navigation, focus states, ARIA on interactive controls,
ESC-to-close dialogs, `prefers-reduced-motion` support, lazy map initialisation,
and debounced search.
