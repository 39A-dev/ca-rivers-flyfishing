import esriConfig from "@arcgis/core/config.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import * as route from "@arcgis/core/rest/route.js";
import RouteParameters from "@arcgis/core/rest/support/RouteParameters.js";
import FeatureSet from "@arcgis/core/rest/support/FeatureSet.js";
import { LAYERS, ROUTING } from "../config.js";

/**
 * Access routing — "get me to the water, avoiding closures."
 *
 * Workflow:
 *   1. User clicks two+ points on the map (trailhead → access point).
 *   2. We solve a route on Esri's World Route service.
 *   3. If "avoid closures" is on, we query LAYERS.roads for segments whose
 *      (field-verified, else published) status reads as closed, and submit them
 *      as polyline barriers so the route detours around them.
 *
 * Requires ROUTING.apiKey (Location Platform key) OR a signed-in named user.
 */
export function createRouting(view, roadsLayer) {
  // Scope the API key to the ROUTE service ONLY — do NOT set esriConfig.apiKey
  // globally, or it overrides the signed-in user's token for hosted-layer edits
  // (the key can read but has no edit rights → applyEdits 403s). An interceptor
  // injects the key as a token just for routing requests; everything else uses
  // the OAuth credential.
  if (ROUTING.apiKey) {
    esriConfig.request.interceptors.push({
      urls: ROUTING.url,
      before(params) {
        params.requestOptions.query = params.requestOptions.query || {};
        params.requestOptions.query.token = ROUTING.apiKey;
      },
    });
  }

  const stopsLayer = new GraphicsLayer({ title: "Route stops", listMode: "hide" });
  const routeLayer = new GraphicsLayer({ title: "Route", listMode: "hide" });
  view.map.addMany([routeLayer, stopsLayer]);

  const state = { active: false, avoidClosures: ROUTING.avoidClosures };
  const panel = buildPanel(state, {
    onToggle: (on) => { state.active = on; if (!on) clearAll(); panel.setStatus(on ? "Click the map to add stops." : ""); },
    onAvoid: (v) => (state.avoidClosures = v),
    onSolve: solve,
    onClear: clearAll,
  });
  view.ui.add(panel.el, "bottom-right");

  const clickHandle = view.on("click", (event) => {
    if (!state.active) return;
    event.stopPropagation(); // don't trigger popups while routing
    addStop(event.mapPoint);
  });

  function addStop(point) {
    const n = stopsLayer.graphics.length + 1;
    stopsLayer.add(new Graphic({
      geometry: point,
      symbol: {
        type: "simple-marker", style: "circle", size: 12,
        color: [255, 255, 255], outline: { color: [20, 83, 45], width: 2 },
      },
      attributes: { label: String(n) },
      // tiny number label
      ...labelFor(n),
    }));
    panel.setStatus(`${stopsLayer.graphics.length} stop(s). Need 2+ to solve.`);
  }

  async function solve() {
    if (stopsLayer.graphics.length < 2) { panel.setStatus("Add at least two stops first."); return; }
    if (!ROUTING.apiKey && !esriConfig.apiKey) {
      panel.setStatus("No routing API key set — add ROUTING.apiKey in config.js.");
      return;
    }
    panel.setStatus("Solving route…");
    routeLayer.removeAll();

    try {
      const barriers = state.avoidClosures ? await closureBarriers() : null;
      const params = new RouteParameters({
        stops: new FeatureSet({ features: stopsLayer.graphics.toArray() }),
        outSpatialReference: view.spatialReference,
        returnDirections: true,
        ...(barriers && barriers.features.length ? { polylineBarriers: barriers } : {}),
      });

      const result = await route.solve(ROUTING.url, params);
      const r = result.routeResults?.[0];
      if (!r) { panel.setStatus("No route found."); return; }

      r.route.symbol = { type: "simple-line", color: [37, 99, 235], width: 5 };
      routeLayer.add(r.route);

      const miles = r.route.attributes.Total_Miles ?? r.route.attributes.Total_Kilometers;
      const min = r.route.attributes.Total_TravelTime;
      const avoided = barriers ? barriers.features.length : 0;
      panel.setStatus(
        `Route: ${miles != null ? miles.toFixed(1) + " mi" : "?"}` +
        `${min != null ? `, ~${Math.round(min)} min` : ""}` +
        `${avoided ? ` · avoided ${avoided} closed segment(s)` : ""}`
      );
      panel.showDirections(r.directions?.features ?? []);
    } catch (err) {
      console.error(err);
      panel.setStatus("Routing failed: " + (err.message || "see console"));
    }
  }

  // Pull closed segments from the road layer as polyline barriers.
  async function closureBarriers() {
    if (!roadsLayer) return null;
    const f = LAYERS.roads.fields;
    // Prefer the field-verified status; fall back to published.
    const statusFields = [f.fieldStatus, f.publishedStatus].filter(Boolean);
    if (!statusFields.length) return null;

    const likeClauses = [];
    for (const field of statusFields) {
      for (const s of ROUTING.closedStatuses) {
        likeClauses.push(`UPPER(${field}) LIKE '%${s.toUpperCase()}%'`);
      }
    }
    const q = roadsLayer.createQuery();
    q.where = likeClauses.join(" OR ");
    q.returnGeometry = true;
    q.outFields = [];
    const { features } = await roadsLayer.queryFeatures(q);
    // Tag each barrier so the route service treats it as a hard restriction.
    for (const g of features) g.attributes = { ...g.attributes, BarrierType: 0 };
    return new FeatureSet({ features });
  }

  function clearAll() {
    stopsLayer.removeAll();
    routeLayer.removeAll();
    panel.showDirections([]);
    panel.setStatus(state.active ? "Click the map to add stops." : "");
  }

  return { state, solve, clearAll, handle: clickHandle };
}

function labelFor(n) {
  // Overlay a text symbol for the stop number via a second graphic is overkill;
  // keep the marker simple. (Hook left here if you want numbered labels.)
  return {};
}

function buildPanel(state, handlers) {
  const el = document.createElement("div");
  el.className = "panel routing-panel";
  el.innerHTML = `
    <div class="panel-head">
      <span>🚗 Access Routing</span>
      <label class="switch"><input type="checkbox" id="rt-active" /><span>on</span></label>
    </div>
    <div class="panel-body">
      <label class="check"><input type="checkbox" id="rt-avoid" ${state.avoidClosures ? "checked" : ""}/> Avoid field-verified closures</label>
      <div class="btn-row">
        <button id="rt-solve" class="btn">Solve route</button>
        <button id="rt-clear" class="btn btn-ghost">Clear</button>
      </div>
      <p class="summary" id="rt-status"></p>
      <ol class="directions" id="rt-directions"></ol>
    </div>`;
  const $ = (id) => el.querySelector("#" + id);
  $("rt-active").addEventListener("change", (e) => handlers.onToggle(e.target.checked));
  $("rt-avoid").addEventListener("change", (e) => handlers.onAvoid(e.target.checked));
  $("rt-solve").addEventListener("click", handlers.onSolve);
  $("rt-clear").addEventListener("click", handlers.onClear);
  return {
    el,
    setStatus: (t) => ($("rt-status").textContent = t),
    showDirections: (feats) => {
      const ol = $("rt-directions");
      ol.innerHTML = feats
        .map((d) => `<li>${d.attributes?.text ?? ""}</li>`)
        .join("");
    },
  };
}
