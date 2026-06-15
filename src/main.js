import Map from "@arcgis/core/Map.js";
import MapView from "@arcgis/core/views/MapView.js";
import LayerList from "@arcgis/core/widgets/LayerList.js";
import Legend from "@arcgis/core/widgets/Legend.js";
import Expand from "@arcgis/core/widgets/Expand.js";
import Search from "@arcgis/core/widgets/Search.js";
import Home from "@arcgis/core/widgets/Home.js";

import { MAP } from "./config.js";
import { buildLayers } from "./layers.js";
import { createSuitability } from "./modules/suitability.js";
import { createEditor } from "./modules/editing.js";
import { createRouting } from "./modules/routing.js";
import { createCatchReports } from "./modules/catch.js";
import { initAuth } from "./auth.js";

import "@arcgis/core/assets/esri/themes/light/main.css";
import "./style.css";

async function start() {
  await initAuth(); // no-op unless PORTAL.appId is set

  const layers = buildLayers();

  // Draw order: streams underneath, points + roads on top.
  const map = new Map({
    basemap: MAP.basemap,
    layers: [layers.streams, layers.streamsEnriched, layers.roads, layers.caltrans, layers.health, layers.bmi, layers.catchReports].filter(Boolean),
  });

  const view = new MapView({
    container: "viewDiv",
    map,
    center: MAP.center,
    zoom: MAP.zoom,
    popup: { dockEnabled: true, dockOptions: { breakpoint: false, position: "bottom-right" } },
  });

  await view.when();

  // ── Core widgets ──────────────────────────────────────────────────────────
  view.ui.add(new Home({ view }), "top-left");
  view.ui.add(
    new Expand({ view, content: new Search({ view }), expandIcon: "search", group: "top-left" }),
    "top-left"
  );
  view.ui.add(
    new Expand({
      view,
      content: new LayerList({ view }),
      expandIcon: "layers",
      expandTooltip: "Layers",
      group: "top-left",
    }),
    "top-left"
  );
  view.ui.add(
    new Expand({
      view,
      content: new Legend({ view }),
      expandIcon: "legend",
      expandTooltip: "Legend",
      group: "top-left",
    }),
    "bottom-left"
  );

  // ── Feature modules ───────────────────────────────────────────────────────
  // 🎣 suitability runs on the ENRICHED layer (gradient data); the full display
  // streams stay visible underneath. Falls back to streams if no enriched layer.
  createSuitability(view, layers.streamsEnriched || layers.streams);
  createEditor(view, layers); // ✏️ BMI / health / road overrides (top-left)
  createRouting(view, layers.roads); // 🚗 access routing, avoids closures (bottom-right)
  createCatchReports(view, layers.catchReports, layers.streamsEnriched); // 📷 photo catch reports (bottom-left)

  window.__view = view; // handy for console debugging
}

start().catch((err) => {
  console.error(err);
  document.getElementById("viewDiv").innerHTML =
    `<div class="boot-error"><h2>Startup error</h2><pre>${err.message}</pre>
     <p>Most often a bad layer URL or field name in <code>src/config.js</code>.</p></div>`;
});
