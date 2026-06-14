# CA Rivers — Fly-Fishing & Stream Health

A custom web app on the **ArcGIS Maps SDK for JavaScript (4.x)** for California
rivers, streams, and creeks. Four capabilities:

1. **Fly-fishing suitability** — filter streams to "viable water" by gradient,
   flow, temperature, and public access. Non-matching reaches dim instead of
   disappearing, so you keep context. (`src/modules/suitability.js`)
2. **Benthic macroinvertebrate (BMI) sampling** — an editable point layer of
   sample sites with EPT richness, biotic index, and CSCI. (`src/modules/editing.js`)
3. **Stream-health readings** — editable water-quality points (temp, DO,
   turbidity, pH, conductivity).
4. **Road closures & access overrides** — an editable road-condition layer where
   field crews override the *published* status with a *field-verified* one.

## Run it

```bash
cd ca-rivers-flyfishing
npm install
npm run dev      # → http://localhost:5173
```

It boots immediately against a public streams layer. The BMI / health / road
layers stay hidden until you point `src/config.js` at real services.

## Make it yours — edit ONE file

Everything you change lives in [`src/config.js`](src/config.js):

- **`LAYERS.*.url`** — paste your existing FeatureServer URLs (or leave the
  public defaults).
- **`LAYERS.*.fields`** — map each logical field to your real attribute name.
  This is the part that matters: the suitability filter and popups read these.
  If a stream suitability field is `null`, its control is hidden automatically.
- **`PORTAL.appId`** — only needed to edit *private* layers (OAuth). Public
  layers that allow anonymous edits need nothing.
- **`SUITABILITY_DEFAULTS`** — the "good water" thresholds.

### Where each requirement is wired

| Requirement | Code | Config |
|---|---|---|
| Viable fly-fishing water | `src/modules/suitability.js` | `LAYERS.streams`, `SUITABILITY_DEFAULTS` |
| Map BMI locations | `src/layers.js`, `src/modules/editing.js` | `LAYERS.bmi` |
| Update stream-health points | `src/modules/editing.js` | `LAYERS.health` |
| Road closures + field overrides | `src/modules/editing.js` | `LAYERS.roads` |

## Your data — what's connected vs. what's missing

Read live from your web map **"CA Streams"** (`0cc0a16ed80f42c39f84ada902623d69`,
org `Uq9r85Potqm3MfRV`):

- **California Streams** (`CA_Streams_wm/FeatureServer/0`) — CDFW + NHD polyline
  hydrography. **Wired in.** But it's **read-only** (Query,Sync) and carries
  only IDs + network topology — **no gradient/flow/temp/access** fields yet.
- **SG Locations / Kern Locations** — map-note markups (OBJECTID + title only),
  not attributed data. Treated as annotation, not used by the modules.

Two gaps to close:

### Enriching streams (so suitability has something to score)

Your streams need fly-fishing attributes. Each can be derived using join keys
already on the layer (`NHD_Permanent_Identifier`, `GNIS_ID`, `DFGWATERID`):

| Attribute | Source | Join on |
|---|---|---|
| Gradient % | DEM (3DEP) slope along the line | geometry |
| Flow (cfs) | USGS NWIS gages / NHDPlus VAA | NHD reach / nearest gage |
| Water temp | NorWeST stream-temp model | NHD reach |
| Public access | PAD-US / CPAD land ownership | spatial overlay |

Add these as fields on a **copy you own** (the source is read-only), populate via
a join/enrichment script, then drop the field names into `config.js`.

**`scripts/enrich_streams.py`** does exactly this for **gradient** (USGS 3DEP
elevation at reach endpoints — fully implemented) and **flow** (recent mean
discharge at the nearest downstream USGS gage via NLDI + NWIS). The statewide
layer is 740k reaches, so it's **scoped + resumable**:

```bash
pip install requests
export ARCGIS_TOKEN="<TroutBookDev user token>"   # see script header
python scripts/enrich_streams.py --where "Name IS NOT NULL" --limit 500
# gradient-only (much faster): add --no-flow
```

It creates `CA_Streams_Enriched` (a layer you own) with `gradient_pct` / `flow_cfs`.
Then point `LAYERS.streams.url` at it and set `fields.gradient = "gradient_pct"`,
`fields.flowCfs = "flow_cfs"` — the suitability filter + score gradient light up.
Temp (NorWeST) and access (PAD-US/CPAD) are left as null columns to wire next.

### Creating the editable layers (BMI / health / roads)

None exist yet. See below.

## Creating the editable layers (if they don't exist yet)

The BMI, health, and road layers are editable point/line layers. Fastest path:
ArcGIS Online → **Content → New item → Feature layer → From scratch**, add the
fields named in `config.js`, enable editing, then paste the resulting
`.../FeatureServer/0` URL into config. (If you'd rather I generate an ArcGIS API
for Python script that creates these with the exact schema, ask — that's a
~40-line script per layer.)

## Suitability — two modes

The panel (top-right) offers:

- **Highlight viable** — SQL `where` from your thresholds; non-matching reaches
  dim & blur (FeatureEffect), keeping context.
- **Score gradient** — an **Arcade** expression grades every reach 0–100 by how
  many weighted criteria it meets, colored red→yellow→green. Tune the weights in
  `SUITABILITY_WEIGHTS` (config.js). Great for "where's the *best* water," not
  just pass/fail.

Both ignore any criterion whose field is `null` in config, and the score
renormalizes so the gradient always spans 0–100.

## Routing — access, avoiding closures

The panel (bottom-right): toggle on, click two+ points (trailhead → access),
**Solve route**. With "Avoid field-verified closures" checked, the app queries
`LAYERS.roads` for segments whose status reads as closed (`ROUTING.closedStatuses`)
and submits them as polyline barriers, so the route detours around them. It
prefers the *field-verified* status over the published one — your override wins.

**Requires an API key.** Esri's World Route service is paid/credentialed. Get a
free-tier key at <https://location.arcgis.com> and paste it into
`ROUTING.apiKey` (config.js). Named-user auth via `PORTAL.appId` also works.
