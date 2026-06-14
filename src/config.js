/**
 * ───────────────────────────────────────────────────────────────────────────
 *  SINGLE SOURCE OF TRUTH — edit this file to point the app at YOUR data.
 * ───────────────────────────────────────────────────────────────────────────
 *
 *  You told me "some layers already exist." Paste their REST endpoint URLs (or
 *  ArcGIS Online item IDs) below. Anything you don't have yet, leave on the
 *  public default — the app still runs, you just swap it later.
 *
 *  How to find a layer URL:
 *    Item page on ArcGIS Online → "View" → copy the ".../FeatureServer/0" URL.
 *  How to find field names:
 *    Open that URL in a browser and read the "Fields" section, OR open the
 *    layer's Data tab in Map Viewer. The FIELDS blocks below MUST match the
 *    real attribute names on your layers or the suitability filter / popups
 *    will silently show nothing.
 */

// ── Portal / auth ───────────────────────────────────────────────────────────
// Only needed for EDITING private layers or saving to a hosted web map.
// For public read-only layers you can ignore all of this.
export const PORTAL = {
  // Your TroutBookDev Location Platform org. Sign-in (and the private editable
  // layers) live here. Anonymous reads of public layers still work without auth.
  url: "https://troutbook.maps.arcgis.com",
  // OAuth 2.0 (user auth) client id — item 174e40347e06429f9c958712b5f0e491.
  // Browser/PKCE app; redirect URI registered: http://localhost:5173
  // (add your production URL in the Location Platform dashboard before deploying).
  appId: "yjCAFl2HTE1D4dLB",
};

// ── Map starting point ──────────────────────────────────────────────────────
export const MAP = {
  basemap: "topo-vector", // good for terrain + stream context
  center: [-120.5, 38.5], // Sierra Nevada-ish; [lon, lat]
  zoom: 7,
};

// ── Layers ──────────────────────────────────────────────────────────────────
// Each entry: a URL plus the field names this app reads/writes. Replace the
// `url` with your existing service; replace the FIELDS with your schema.

export const LAYERS = {
  /**
   * 1) STREAMS — the base hydrography you assess for fly-fishing suitability.
   *    Likely an existing NHD-derived line layer in your org.
   *    Default below is Esri's public "USA Rivers and Streams".
   */
  streams: {
    title: "California Streams",
    // DISPLAY layer — the FULL statewide hydrography (740k reaches). This is the
    // water network you actually see. It's PUBLIC (anonymous-readable), so it
    // renders even before sign-in. No fly-fishing attributes — suitability runs
    // on `streamsEnriched` below, not here. (minScale keeps it fast; zoom in.)
    url: "https://services2.arcgis.com/Uq9r85Potqm3MfRV/ArcGIS/rest/services/CA_Streams_wm/FeatureServer/0",
    fields: {
      name: "Name", // reach name (often null; GNIS_ID is a fallback)
      gradient: null, // no attributes on the display layer — see streamsEnriched
      flowCfs: null,
      tempF: null,
      publicAccess: null,
      species: null,
    },
    joinKeys: { nhd: "NHD_Permanent_Identifier", gnis: "GNIS_ID", dfg: "DFGWATERID" },
    network: { downstreamId: "Down_ID", id: "DFGWATERID", mouthMeasure: "Mouth_Meas" },
  },

  /**
   * 1b) ENRICHED STREAMS — the SUITABILITY layer. A copy you own, populated by
   *    scripts/enrich_streams.py with gradient_pct (+ flow_cfs when run without
   *    --no-flow). The suitability panel filters/scores THESE reaches; they draw
   *    on top of the full display network. San Gabriel is enriched so far —
   *    re-run the script on more bboxes to grow coverage (it appends).
   *    NOTE: private to your org, so suitability needs sign-in; the display
   *    streams above stay visible to everyone.
   */
  streamsEnriched: {
    title: "Streams — fly-fishing suitability",
    url: "https://services8.arcgis.com/GfY0eEKd00oAzkH5/arcgis/rest/services/CA_Streams_Enriched/FeatureServer/0",
    fields: {
      name: "Name",
      gradient: "gradient_pct", // ✅ populated (3DEP slope at endpoints)
      flowCfs: null, // set to "flow_cfs" after a flow-enabled enrichment run
      tempF: null,
      publicAccess: null,
      species: null,
    },
  },

  /**
   * 2) BENTHIC MACROINVERTEBRATE (BMI) sample sites — point layer.
   *    Editable: field crews add samples. Default = empty placeholder; create a
   *    hosted layer with this schema (see README → "Creating the BMI layer").
   */
  bmi: {
    title: "Benthic Macroinvertebrate Sites",
    url: "https://services8.arcgis.com/GfY0eEKd00oAzkH5/arcgis/rest/services/CA_Rivers_BMI_Sites/FeatureServer/0",
    editable: true,
    fields: {
      siteName: "site_name",
      sampleDate: "sample_date",
      eptRichness: "ept_richness", // # of Ephemeroptera/Plecoptera/Trichoptera taxa
      bioticIndex: "biotic_index", // Hilsenhoff or similar
      csci: "csci_score", // CA Stream Condition Index
      taxa: "taxa_notes",
    },
  },

  /**
   * 3) STREAM HEALTH monitoring points — editable water-quality readings.
   */
  health: {
    title: "Stream Health Readings",
    url: "https://services8.arcgis.com/GfY0eEKd00oAzkH5/arcgis/rest/services/CA_Rivers_Stream_Health/FeatureServer/0",
    editable: true,
    fields: {
      station: "station_id",
      readingDate: "reading_date",
      tempF: "temp_f",
      dissolvedOxygen: "do_mgl", // mg/L
      turbidity: "turbidity_ntu",
      ph: "ph",
      conductivity: "conductivity_uscm",
    },
  },

  /**
   * 4) ROAD CLOSURES / ACCESS — editable so field users can override the
   *    published condition when reality differs ("field-verified" workflow).
   *    Default = Caltrans public lane-closures (read-only sample).
   */
  roads: {
    title: "Road Closures & Access",
    url: "https://services8.arcgis.com/GfY0eEKd00oAzkH5/arcgis/rest/services/CA_Rivers_Road_Access/FeatureServer/0",
    editable: true,
    fields: {
      routeName: "route_name",
      publishedStatus: "published_status", // what the official source says
      fieldStatus: "field_status", // what a crew member observed (override)
      verifiedBy: "verified_by",
      verifiedDate: "verified_date",
      notes: "condition_notes",
    },
  },

  /**
   * 5) CALTRANS LCS — live, authoritative closures (READ-ONLY external reference).
   *    This is real Caltrans Lane Closure System data (District 3: Sacramento +
   *    northern Sierra — American/Yuba/Truckee fly water), republished by
   *    El Dorado County GIS. ~950 live records, refreshed continuously.
   *
   *    It is NOT edited here — it's the "official" track that sits alongside your
   *    editable Road Closures layer (the "field-verified" track). When the feed
   *    is stale or wrong, your field override wins (routing prefers field_status).
   *
   *    Coverage note: this layer is District 3 only. For District 7 (Angeles
   *    Crest / SR-2) or statewide, swap `url` for a D7 LCS service or the Caltrans
   *    QuickMap statewide feed (https://quickmap.dot.ca.gov/data/lcs2way.kml,
   *    loaded via a KMLLayer) — see README → "Caltrans live layer".
   */
  caltrans: {
    title: "Caltrans Closures — official (statewide)",
    // STATEWIDE official Caltrans Lane Closure System feed (QuickMap). Covers
    // every district INCLUDING D7 / Angeles Crest (SR-2). ~238 live closures.
    // Loaded as a KMLLayer: the feed sends no CORS headers, so the SDK proxies it
    // through Esri's KML utility service (works for signed-in users). Popups come
    // from the KML balloon (Caltrans' own HTML).
    kmlUrl: "https://quickmap.dot.ca.gov/data/lcs2way.kml",
    // Fallback — a clean FeatureLayer with nicer popups but DISTRICT 3 ONLY
    // (El Dorado County republish). Comment out kmlUrl and uncomment this to use:
    // url: "https://services.arcgis.com/UHg8l1wC48WQyDSO/arcgis/rest/services/lcsStatusD03/FeatureServer/0",
    editable: false, // read-only reference; the Editor skips it
    // fields below are only read by the FeatureLayer fallback (KML carries its own)
    fields: {
      route: "beginRoute",
      county: "beginCounty",
      place: "beginNearbyPlace",
      desc: "beginFreeFormDescription",
      type: "typeOfClosure",
      work: "typeOfWork",
      lanesClosed: "lanesClosed",
      totalLanes: "totalExistingLanes",
      start: "closureStartDate",
      recorded: "recordDate",
      delay: "estimatedDelay",
    },
  },
};

// ── Fly-fishing suitability defaults (used by the suitability panel) ─────────
// These are the "good water" thresholds. Tune to taste. A reach passes when it
// satisfies every ENABLED criterion (criteria whose field is null are ignored).
export const SUITABILITY_DEFAULTS = {
  gradientMaxPct: 4, // walkable/wadeable; steeper = pocket water
  flowMinCfs: 50,
  flowMaxCfs: 800,
  tempMaxF: 68, // trout stress above ~68°F
  requirePublicAccess: true,
};

// Scoring weights for the "color by suitability score" renderer (0–100). Each
// enabled criterion contributes its weight when satisfied; weights of disabled
// (null-field) criteria are redistributed so the score always spans 0–100.
export const SUITABILITY_WEIGHTS = {
  gradient: 25,
  flow: 30,
  temp: 30,
  access: 15,
};

// ── Routing / access ────────────────────────────────────────────────────────
// "Route me to open access, avoiding closures." Uses Esri's World Route service,
// which requires an API key from the ArcGIS Location Platform (or named-user
// auth via PORTAL.appId). Closed road segments from LAYERS.roads become barriers
// the route avoids.
export const ROUTING = {
  url: "https://route-api.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World",
  // API key is read from an env var so it's NEVER committed. Local dev: put it in
  // .env.local (gitignored). Production build: a VITE_ARCGIS_API_KEY GitHub Actions
  // secret. The key must still be HTTP-referrer-restricted to your domain — see DEPLOY.md.
  apiKey: import.meta.env.VITE_ARCGIS_API_KEY || "",
  avoidClosures: true,
  // A road segment counts as "closed" when its field-verified status (preferred)
  // or published status matches one of these (case-insensitive substring match).
  closedStatuses: ["closed", "impassable", "washed out", "slide"],
};
