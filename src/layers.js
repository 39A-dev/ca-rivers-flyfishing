import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import KMLLayer from "@arcgis/core/layers/KMLLayer.js";
import { LAYERS } from "./config.js";

/**
 * Build the FeatureLayers from config. Layers with no `url` are skipped (so the
 * app runs before you've created the BMI / health / road layers). Each returned
 * layer is tagged with `__key` so other modules can find it on the map.
 */
export function buildLayers() {
  const out = {};

  // 1) Streams — the assessment base layer.
  out.streams = new FeatureLayer({
    url: LAYERS.streams.url,
    title: LAYERS.streams.title,
    outFields: ["*"],
    // The source has 740k reaches — drawing them all at statewide zoom stalls the
    // GPU. Only render once zoomed into a region (~county level). Zoom to your
    // water and the reaches appear; the statewide view stays fast.
    minScale: 1500000,
    popupTemplate: {
      title: `{${LAYERS.streams.fields.name}}`,
      content: streamPopupContent(),
    },
  });
  tag(out.streams, "streams");

  // 2) BMI sample sites.
  if (LAYERS.bmi.url) {
    const f = LAYERS.bmi.fields;
    out.bmi = new FeatureLayer({
      url: LAYERS.bmi.url,
      title: LAYERS.bmi.title,
      outFields: ["*"],
      popupTemplate: {
        title: `BMI site: {${f.siteName}}`,
        content: [
          {
            type: "fields",
            fieldInfos: [
              { fieldName: f.sampleDate, label: "Sampled" },
              { fieldName: f.eptRichness, label: "EPT richness" },
              { fieldName: f.bioticIndex, label: "Biotic index" },
              { fieldName: f.csci, label: "CSCI score" },
              { fieldName: f.taxa, label: "Taxa notes" },
            ],
          },
        ],
      },
      renderer: simplePoint([34, 139, 34]), // forest green
    });
    tag(out.bmi, "bmi");
  }

  // 3) Stream-health readings.
  if (LAYERS.health.url) {
    const f = LAYERS.health.fields;
    out.health = new FeatureLayer({
      url: LAYERS.health.url,
      title: LAYERS.health.title,
      outFields: ["*"],
      popupTemplate: {
        title: `Reading @ {${f.station}}`,
        content: [
          {
            type: "fields",
            fieldInfos: [
              { fieldName: f.readingDate, label: "Date" },
              { fieldName: f.tempF, label: "Temp (°F)" },
              { fieldName: f.dissolvedOxygen, label: "DO (mg/L)" },
              { fieldName: f.turbidity, label: "Turbidity (NTU)" },
              { fieldName: f.ph, label: "pH" },
              { fieldName: f.conductivity, label: "Conductivity (µS/cm)" },
            ],
          },
        ],
      },
      renderer: simplePoint([30, 144, 255]), // dodger blue
    });
    tag(out.health, "health");
  }

  // 4) Road closures / access overrides.
  if (LAYERS.roads.url) {
    const f = LAYERS.roads.fields;
    out.roads = new FeatureLayer({
      url: LAYERS.roads.url,
      title: LAYERS.roads.title,
      outFields: ["*"],
      popupTemplate: {
        title: `{${f.routeName}}`,
        content: [
          {
            type: "fields",
            fieldInfos: [
              { fieldName: f.publishedStatus, label: "Published status" },
              { fieldName: f.fieldStatus, label: "Field-verified status" },
              { fieldName: f.verifiedBy, label: "Verified by" },
              { fieldName: f.verifiedDate, label: "Verified" },
              { fieldName: f.notes, label: "Notes" },
            ],
          },
        ],
      },
    });
    tag(out.roads, "roads");
  }

  // 5) Caltrans LCS — official closures (read-only external reference).
  //    Preferred: statewide KML feed (covers D7 / Angeles Crest).
  if (LAYERS.caltrans?.kmlUrl) {
    out.caltrans = new KMLLayer({
      url: LAYERS.caltrans.kmlUrl,
      title: LAYERS.caltrans.title,
    });
    tag(out.caltrans, "caltrans");
  } else if (LAYERS.caltrans?.url) {
    // Fallback: a FeatureLayer (e.g. the District-3 republish) with a custom popup.
    const f = LAYERS.caltrans.fields;
    out.caltrans = new FeatureLayer({
      url: LAYERS.caltrans.url,
      title: LAYERS.caltrans.title,
      outFields: ["*"],
      popupTemplate: {
        title: `SR {${f.route}} — {${f.place}} ({${f.county}} Co.)`,
        content: [
          {
            type: "fields",
            fieldInfos: [
              { fieldName: f.type, label: "Closure type" },
              { fieldName: f.work, label: "Work" },
              { fieldName: f.desc, label: "Description" },
              { fieldName: f.lanesClosed, label: "Lanes closed" },
              { fieldName: f.totalLanes, label: "Total lanes" },
              { fieldName: f.delay, label: "Est. delay" },
              { fieldName: f.start, label: "Closure start" },
              { fieldName: f.recorded, label: "Last updated" },
            ],
          },
        ],
      },
      // amber warning markers, distinct from your editable road layer
      renderer: {
        type: "simple",
        symbol: {
          type: "simple-marker", style: "diamond", size: 11,
          color: [240, 145, 20], outline: { color: [120, 60, 0], width: 1 },
        },
      },
    });
    tag(out.caltrans, "caltrans");
  }

  return out;
}

// Popup for streams: show whatever suitability fields are actually configured.
function streamPopupContent() {
  const f = LAYERS.streams.fields;
  const rows = [
    [f.gradient, "Gradient (%)"],
    [f.flowCfs, "Flow (cfs)"],
    [f.tempF, "Temp (°F)"],
    [f.publicAccess, "Public access"],
    [f.species, "Species"],
  ].filter(([field]) => field); // drop unconfigured fields
  if (!rows.length) return "No suitability attributes configured yet.";
  return [
    {
      type: "fields",
      fieldInfos: rows.map(([fieldName, label]) => ({ fieldName, label })),
    },
  ];
}

function simplePoint(rgb) {
  return {
    type: "simple",
    symbol: {
      type: "simple-marker",
      size: 8,
      color: rgb,
      outline: { color: [255, 255, 255], width: 1 },
    },
  };
}

function tag(layer, key) {
  layer.__key = key;
}
