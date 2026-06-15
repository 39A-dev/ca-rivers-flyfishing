import exifr from "exifr";
import Point from "@arcgis/core/geometry/Point.js";
import Graphic from "@arcgis/core/Graphic.js";
import { geographicToWebMercator } from "@arcgis/core/geometry/support/webMercatorUtils.js";
import * as geometryEngine from "@arcgis/core/geometry/geometryEngine.js";
import { SUITABILITY_WEIGHTS, CATCH_LINK_RADIUS_M } from "../config.js";

/**
 * 📷 Log a catch — angler photo → catch report → suitability bonus.
 *
 *   1. Pick a photo (mobile: camera/gallery; desktop: file).
 *   2. Read its EXIF GPS → plot the point. No GPS? tap the map to place it.
 *   3. Save the point + the photo (as an attachment) + a "trout caught" flag to
 *      the Catch Reports layer.
 *   4. If a trout was caught, find the nearest stream reach within
 *      CATCH_LINK_RADIUS_M and bump its catch_count — which the suitability
 *      score reads as the highest-weighted, crowd-sourced "caught here" criterion.
 */
export function createCatchReports(view, catchLayer, enrichedLayer) {
  if (!catchLayer) return null;

  const state = { file: null, point: null, fromExif: false, placing: false };
  const panel = buildPanel({
    onFile: handleFile,
    onSubmit: submit,
    onPlaceToggle: () => { state.placing = true; setStatus("Tap the map where you caught it…"); },
  });
  view.ui.add(panel.el, "bottom-left");

  // tap-to-place (used when a photo has no GPS, or to override)
  const clickHandle = view.on("click", (e) => {
    if (!state.placing) return;
    e.stopPropagation();
    state.point = e.mapPoint; // already in view SR
    state.fromExif = false;
    state.placing = false;
    showPreviewPin(state.point);
    setStatus("📍 Location set. Add your catch.");
  });

  async function handleFile(file) {
    if (!file) return;
    state.file = file;
    state.point = null;
    setStatus("Reading photo…");
    let gps = null, date = null;
    try { gps = await exifr.gps(file); } catch { /* no exif */ }
    try { date = (await exifr.parse(file, ["DateTimeOriginal"]))?.DateTimeOriginal || null; } catch { /* none */ }
    panel.setDate(date);
    if (gps && gps.latitude != null && gps.longitude != null) {
      state.point = geographicToWebMercator(new Point({ longitude: gps.longitude, latitude: gps.latitude }));
      state.fromExif = true;
      showPreviewPin(state.point);
      view.goTo({ target: state.point, zoom: Math.max(view.zoom, 13) });
      setStatus("📍 Located from photo GPS. Add your catch.");
    } else {
      state.fromExif = false;
      state.placing = true;
      setStatus("No GPS in this photo — tap the map to place it.");
    }
  }

  function showPreviewPin(point) {
    view.graphics.removeAll();
    view.graphics.add(new Graphic({
      geometry: point,
      symbol: { type: "simple-marker", style: "circle", size: 13, color: [255, 170, 0], outline: { color: [120, 60, 0], width: 2 } },
    }));
  }

  async function submit() {
    if (!state.file) { setStatus("Pick a photo first."); return; }
    if (!state.point) { setStatus("Set a location (photo GPS or tap the map)."); return; }
    const vals = panel.getValues();
    setStatus("Saving…");
    try {
      // 1) add the catch point
      const add = await catchLayer.applyEdits({ addFeatures: [new Graphic({
        geometry: state.point,
        attributes: {
          species: vals.species,
          has_trout: vals.trout ? 1 : 0,
          caught_on: vals.date ? vals.date.getTime() : null,
          notes: vals.notes || null,
          source: state.fromExif ? "photo upload (EXIF GPS)" : "photo upload (tap-placed)",
        },
      })] });
      const oid = add.addFeatureResults?.[0]?.objectId;
      if (oid == null) throw new Error("add failed");

      // 2) attach the photo
      const fd = new FormData();
      fd.append("attachment", state.file, state.file.name || "catch.jpg");
      await catchLayer.addAttachment(new Graphic({ attributes: { [catchLayer.objectIdField]: oid } }), fd);

      // 3) trout? bump the nearest reach's catch_count → suitability
      let linked = null;
      if (vals.trout && enrichedLayer) linked = await bumpNearestReach(state.point);

      catchLayer.refresh();
      if (linked) enrichedLayer.refresh();
      setStatus(linked
        ? `✅ Catch logged — boosted the nearest reach (${linked} report${linked > 1 ? "s" : ""} now).`
        : "✅ Catch logged.");
      panel.reset(); state.file = null; state.point = null; view.graphics.removeAll();
    } catch (err) {
      console.error(err);
      setStatus("Save failed: " + (err.message || "see console"));
    }
  }

  async function bumpNearestReach(point) {
    const q = enrichedLayer.createQuery();
    q.geometry = point;
    q.distance = CATCH_LINK_RADIUS_M;
    q.units = "meters";
    q.spatialRelationship = "intersects";
    q.returnGeometry = true;
    q.outFields = ["OBJECTID", "catch_count"];
    const { features } = await enrichedLayer.queryFeatures(q);
    if (!features.length) return null;
    // nearest of the candidates
    let best = features[0], bestD = Infinity;
    for (const f of features) {
      const d = geometryEngine.distance(point, f.geometry, "meters");
      if (d < bestD) { bestD = d; best = f; }
    }
    const next = (best.attributes.catch_count || 0) + 1;
    await enrichedLayer.applyEdits({ updateFeatures: [new Graphic({
      attributes: { OBJECTID: best.attributes.OBJECTID, catch_count: next },
    })] });
    return next;
  }

  function setStatus(t) { panel.setStatus(t); }
  return { handle: clickHandle };
}

function buildPanel(handlers) {
  const el = document.createElement("div");
  el.className = "panel catch-panel";
  el.innerHTML = `
    <div class="panel-head"><span>📷 Log a Catch</span></div>
    <div class="panel-body">
      <label class="filebtn">
        <input type="file" id="cr-file" accept="image/*" />
        <span>Choose photo…</span>
      </label>
      <label class="check"><input type="checkbox" id="cr-trout" checked/> Trout caught here</label>
      <label class="range"><span>Species</span>
        <select id="cr-species">
          <option>Rainbow trout</option><option>Brown trout</option>
          <option>Brook trout</option><option>Other trout</option><option>Other</option>
        </select>
      </label>
      <input type="text" id="cr-notes" class="txt" placeholder="Notes (optional)" />
      <p class="muted" id="cr-date"></p>
      <div class="btn-row"><button id="cr-place" class="btn btn-ghost">Tap to place</button>
        <button id="cr-submit" class="btn">Add catch</button></div>
      <p class="summary" id="cr-status">Pick a photo — its GPS plots the catch (or tap the map).</p>
    </div>`;
  const $ = (id) => el.querySelector("#" + id);
  $("cr-file").addEventListener("change", (e) => handlers.onFile(e.target.files[0]));
  $("cr-place").addEventListener("click", handlers.onPlaceToggle);
  $("cr-submit").addEventListener("click", handlers.onSubmit);
  let date = null;
  return {
    el,
    setStatus: (t) => ($("cr-status").textContent = t),
    setDate: (d) => { date = d; $("cr-date").textContent = d ? "Taken: " + d.toLocaleDateString() : ""; },
    getValues: () => ({ trout: $("cr-trout").checked, species: $("cr-species").value, notes: $("cr-notes").value, date }),
    reset: () => { $("cr-file").value = ""; $("cr-notes").value = ""; $("cr-date").textContent = ""; date = null; },
  };
}
