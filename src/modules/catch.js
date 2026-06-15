import exifr from "exifr";
import Point from "@arcgis/core/geometry/Point.js";
import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import esriRequest from "@arcgis/core/request.js";
import { geographicToWebMercator } from "@arcgis/core/geometry/support/webMercatorUtils.js";
import * as geometryEngine from "@arcgis/core/geometry/geometryEngine.js";
import { CATCH_LINK_RADIUS_M, CATCH_CONNECT_SNAP_M } from "../config.js";

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

  // circular photo-thumbnail markers, drawn over the catch points
  const thumbs = new GraphicsLayer({ title: "Catch photos", listMode: "hide" });
  view.map.add(thumbs);
  catchLayer.when(() => refreshThumbs());

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

      // 3) trout? propagate the boost along the connected stream → suitability
      let linked = null;
      if (vals.trout && enrichedLayer) linked = await bumpConnectedReaches(state.point);

      catchLayer.refresh();
      refreshThumbs();
      if (linked) enrichedLayer.refresh();
      setStatus(linked
        ? `✅ Catch logged — marked ${linked} connected reach${linked > 1 ? "es" : ""} as prime water.`
        : "✅ Catch logged.");
      panel.reset(); state.file = null; state.point = null; view.graphics.removeAll();
    } catch (err) {
      console.error(err);
      setStatus("Save failed: " + (err.message || "see console"));
    }
  }

  // A catch marks the whole STREAM it's on, not just one reach. Snap to the
  // nearest reach; if it has a name, bump every reach of that named stream
  // (e.g. "West Fork San Gabriel River"). If it's unnamed, fall back to walking
  // the chain of reaches that touch end-to-end.
  async function bumpConnectedReaches(point) {
    const nq = enrichedLayer.createQuery();
    nq.geometry = point; nq.distance = CATCH_LINK_RADIUS_M; nq.units = "meters";
    nq.spatialRelationship = "intersects"; nq.returnGeometry = true; nq.outFields = ["OBJECTID", "Name"];
    const near = (await enrichedLayer.queryFeatures(nq)).features;
    if (!near.length) return null;
    let start = near[0], bestD = Infinity;
    for (const fe of near) { const d = geometryEngine.distance(point, fe.geometry, "meters"); if (d < bestD) { bestD = d; start = fe; } }

    const streamName = start.attributes.Name;
    let targetOids;

    if (streamName) {
      // name-based: the whole named stream
      const q = enrichedLayer.createQuery();
      q.where = `Name = '${streamName.replace(/'/g, "''")}'`;
      q.outFields = ["OBJECTID", "catch_count"]; q.returnGeometry = false;
      const feats = (await enrichedLayer.queryFeatures(q)).features;
      targetOids = feats.map(f => [f.attributes.OBJECTID, f.attributes.catch_count]);
    } else {
      // geometric fallback: contiguous (touching) reaches
      const allQ = enrichedLayer.createQuery();
      allQ.where = "1=1"; allQ.returnGeometry = true; allQ.outFields = ["OBJECTID", "catch_count"];
      const all = (await enrichedLayer.queryFeatures(allQ)).features;
      const byOid = new Map(all.map(fe => [fe.attributes.OBJECTID, fe]));
      const ends = (g) => { const p = g.paths[0]; return [p[0], p[p.length - 1]]; };
      const touch = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= CATCH_CONNECT_SNAP_M;
      const seen = new Set([start.attributes.OBJECTID]);
      const queue = [byOid.get(start.attributes.OBJECTID) || start];
      while (queue.length) {
        const cur = queue.shift();
        const ce = ends(cur.geometry);
        for (const fe of all) {
          if (seen.has(fe.attributes.OBJECTID)) continue;
          if (ce.some(c => ends(fe.geometry).some(e => touch(c, e)))) { seen.add(fe.attributes.OBJECTID); queue.push(fe); }
        }
      }
      targetOids = [...seen].map(oid => [oid, byOid.get(oid)?.attributes.catch_count]);
    }

    const updates = targetOids.map(([oid, cc]) => new Graphic({
      attributes: { OBJECTID: oid, catch_count: (cc || 0) + 1 },
    }));
    await enrichedLayer.applyEdits({ updateFeatures: updates });
    return updates.length;
  }

  // Build circular photo-thumbnail markers from each catch's first attachment.
  async function refreshThumbs() {
    try {
      thumbs.removeAll();
      const q = catchLayer.createQuery();
      q.where = "1=1"; q.returnGeometry = true; q.outFields = [catchLayer.objectIdField];
      const feats = (await catchLayer.queryFeatures(q)).features;
      for (const fe of feats) {
        const oid = fe.attributes[catchLayer.objectIdField];
        let atts;
        try { atts = await catchLayer.queryAttachments({ objectIds: [oid] }); } catch { continue; }
        const list = atts[oid];
        if (!list || !list.length) continue;
        try {
          const resp = await esriRequest(list[0].url, { responseType: "blob" }); // SDK adds the token
          const bmp = await createImageBitmap(resp.data);
          thumbs.add(new Graphic({
            geometry: fe.geometry,
            symbol: { type: "picture-marker", url: circularThumb(bmp, 72), width: "42px", height: "42px" },
          }));
        } catch { /* skip this one */ }
      }
    } catch { /* layer not ready / no auth yet */ }
  }

  // Cover-crop the photo into a bordered circle, return a data URL.
  function circularThumb(bmp, size) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const r = size / 2;
    const s = Math.min(bmp.width, bmp.height); // square cover-crop
    const sx = (bmp.width - s) / 2, sy = (bmp.height - s) / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(r, r, r - 3, 0, 2 * Math.PI); ctx.clip();
    ctx.drawImage(bmp, sx, sy, s, s, 0, 0, size, size);
    ctx.restore();
    ctx.beginPath(); ctx.arc(r, r, r - 2.5, 0, 2 * Math.PI);
    ctx.lineWidth = 5; ctx.strokeStyle = "#ff8c00"; ctx.stroke();
    return c.toDataURL("image/png");
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
