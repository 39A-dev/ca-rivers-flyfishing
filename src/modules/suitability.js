import { LAYERS, SUITABILITY_DEFAULTS, SUITABILITY_WEIGHTS, CATCH_PRIME_FLOOR } from "../config.js";

/**
 * Fly-fishing suitability — two complementary views over the streams layer:
 *
 *   • FILTER mode  — a SQL `where` applied as a FeatureEffect: viable reaches
 *     stay crisp, the rest dim/blur (kept for context).
 *   • SCORE mode   — an Arcade-driven color gradient (red→yellow→green) grading
 *     every reach 0–100 by how many weighted criteria it meets. Better for
 *     "where's the BEST water," not just pass/fail.
 *
 * Criteria whose field is `null` in config are skipped everywhere automatically,
 * and the score weights redistribute so the gradient always spans 0–100.
 */
export function createSuitability(view, streamsLayer, displayLayer) {
  // Read the field mapping of the layer ACTUALLY passed in (e.g. streamsEnriched),
  // not a hardcoded one — otherwise the wrong layer's fields drive the panel.
  const f = (streamsLayer.__key && LAYERS[streamsLayer.__key]?.fields) || LAYERS.streams.fields;
  const state = { ...SUITABILITY_DEFAULTS, mode: "off" }; // off | filter | score
  const originalRenderer = streamsLayer.renderer; // restore when leaving score mode

  const has = {
    gradient: !!f.gradient,
    flow: !!f.flowCfs,
    temp: !!f.tempF,
    access: !!f.publicAccess,
    catch: !!f.catch, // crowd-sourced trout catches (score bonus only, no control)
  };

  const panel = buildPanel(state, has, () => applyAndFocus());
  view.ui.add(panel.el, "top-right");

  // ── Filter (SQL where) ──────────────────────────────────────────────────
  function buildWhere() {
    // A reach is "viable" if it passes every criterion it HAS DATA for. Missing
    // data (NULL) on a criterion never excludes the reach — it just isn't judged
    // on that factor (`field IS NULL OR <passes>`).
    const c = [];
    if (has.gradient) c.push(`(${f.gradient} IS NULL OR ${f.gradient} <= ${state.gradientMaxPct})`);
    if (has.flow) c.push(`(${f.flowCfs} IS NULL OR (${f.flowCfs} >= ${state.flowMinCfs} AND ${f.flowCfs} <= ${state.flowMaxCfs}))`);
    if (has.temp) c.push(`(${f.tempF} IS NULL OR ${f.tempF} <= ${state.tempMaxF})`);
    if (has.access && state.requirePublicAccess) c.push(`(${f.publicAccess} IS NULL OR ${f.publicAccess} IN ('Y','Yes','TRUE','1','t'))`);
    return c.length ? c.join(" AND ") : "1=1";
  }

  // ── Score (Arcade 0–100) ────────────────────────────────────────────────
  function buildScoreArcade() {
    // Per reach: each criterion contributes its weight to BOTH the denominator
    // (max) and — if passed — the numerator (s), but ONLY when that reach has
    // data for it. A null field is skipped for that reach, so missing data never
    // drags the score down; the reach is simply judged on what it has.
    const lines = ["var s = 0;", "var max = 0;"];
    const crit = [
      [has.gradient, SUITABILITY_WEIGHTS.gradient, f.gradient, `$feature.${f.gradient} <= ${state.gradientMaxPct}`],
      [has.flow, SUITABILITY_WEIGHTS.flow, f.flowCfs, `$feature.${f.flowCfs} >= ${state.flowMinCfs} && $feature.${f.flowCfs} <= ${state.flowMaxCfs}`],
      [has.temp, SUITABILITY_WEIGHTS.temp, f.tempF, `$feature.${f.tempF} <= ${state.tempMaxF}`],
      [has.access, SUITABILITY_WEIGHTS.access, f.publicAccess, `$feature.${f.publicAccess} == 'Y' || $feature.${f.publicAccess} == 'Yes' || $feature.${f.publicAccess} == 'TRUE' || $feature.${f.publicAccess} == '1'`],
    ];
    for (const [enabled, weight, field, test] of crit) {
      if (!enabled) continue;
      lines.push(`if (!IsEmpty($feature.${field})) { max += ${weight}; if (${test}) { s += ${weight}; } }`);
    }
    lines.push("var base = IIf(max > 0, (s / max) * 100, 50);"); // modeled score
    // A reported trout catch is proof, not prediction: floor the score at prime.
    if (has.catch) {
      lines.push(`return IIf(!IsEmpty($feature.${f.catch}) && $feature.${f.catch} > 0, Max(base, ${CATCH_PRIME_FLOOR}), base);`);
    } else {
      lines.push("return base;");
    }
    return lines.join("\n");
  }

  function scoreRenderer() {
    const expr = buildScoreArcade();
    return {
      type: "simple",
      symbol: { type: "simple-line", width: 4, color: [120, 120, 120] },
      visualVariables: [
        {
          type: "color",
          valueExpression: expr,
          stops: [
            { value: 0, color: [200, 50, 40], label: "Poor" },
            { value: 50, color: [240, 200, 40], label: "Fair" },
            { value: 100, color: [40, 160, 70], label: "Prime" },
          ],
        },
        {
          // bold so the scored reaches read clearly over the base network
          type: "size",
          valueExpression: expr,
          stops: [{ value: 0, size: 3 }, { value: 100, size: 8 }],
        },
      ],
    };
  }

  function apply() {
    // Reset both effects, then apply the active one.
    streamsLayer.featureEffect = null;
    streamsLayer.renderer = originalRenderer;
    // Dim the full base-streams network while judging, so the scored/filtered
    // reaches stand out (restore it when off).
    if (displayLayer && displayLayer !== streamsLayer) {
      displayLayer.opacity = state.mode === "off" ? 1 : 0.25;
    }

    if (state.mode === "off") {
      panel.setSummary("Off — showing all reaches as-is.");
      return;
    }
    if (state.mode === "filter") {
      const where = buildWhere();
      streamsLayer.featureEffect = {
        filter: { where },
        excludedEffect: "opacity(15%) grayscale(80%) blur(0.6px)",
      };
      panel.setSummary(where === "1=1"
        ? "No suitability fields configured — set them in config.js."
        : `Viable water where: ${where}`);
      return;
    }
    if (state.mode === "score") {
      const anyCriteria = has.gradient || has.flow || has.temp || has.access;
      if (!anyCriteria) {
        panel.setSummary("No suitability fields configured — set them in config.js.");
        return;
      }
      streamsLayer.renderer = scoreRenderer();
      panel.setSummary("Colored by suitability score (red → green).");
    }
  }

  // When the user first turns on a scoring/filter mode, fly to the scored reaches
  // so they don't have to hunt for the (sparse) enriched water.
  let lastMode = "off";
  const applyAndFocus = async () => {
    apply();
    if (lastMode === "off" && state.mode !== "off") {
      try {
        const r = await streamsLayer.queryExtent();
        if (r.extent) view.goTo(r.extent.expand(1.4), { duration: 800 });
      } catch { /* ignore */ }
    }
    lastMode = state.mode;
  };

  apply();
  return { apply: applyAndFocus, state };
}

function buildPanel(state, has, onChange) {
  const el = document.createElement("div");
  el.className = "panel suitability-panel";
  const noFields = !has.gradient && !has.flow && !has.temp && !has.access;

  el.innerHTML = `
    <div class="panel-head"><span>🎣 Fly-Fishing Suitability</span></div>
    <div class="panel-body">
      <div class="seg">
        <label><input type="radio" name="su-mode" value="off" checked/> Off</label>
        <label><input type="radio" name="su-mode" value="filter"/> Highlight viable</label>
        <label><input type="radio" name="su-mode" value="score"/> Score gradient</label>
      </div>
      ${noFields ? `<p class="warn">No stream suitability fields configured. Open
        <code>src/config.js</code> → <code>LAYERS.streams.fields</code>, set real
        field names, reload.</p>` : ""}
      ${has.gradient ? row("Max gradient %", "su-grad", state.gradientMaxPct, 0, 12, 0.5) : ""}
      ${has.flow ? row("Min flow (cfs)", "su-flowmin", state.flowMinCfs, 0, 2000, 10) : ""}
      ${has.flow ? row("Max flow (cfs)", "su-flowmax", state.flowMaxCfs, 0, 5000, 10) : ""}
      ${has.temp ? row("Max temp (°F)", "su-temp", state.tempMaxF, 40, 80, 1) : ""}
      ${has.access ? `<label class="check"><input type="checkbox" id="su-access" ${state.requirePublicAccess ? "checked" : ""}/> Require public access</label>` : ""}
      <p class="summary" id="su-summary"></p>
    </div>`;

  const $ = (id) => el.querySelector("#" + id);
  el.querySelectorAll('input[name="su-mode"]').forEach((r) =>
    r.addEventListener("change", (e) => { state.mode = e.target.value; onChange(); }));
  bindRange($, "su-grad", (v) => (state.gradientMaxPct = v), onChange);
  bindRange($, "su-flowmin", (v) => (state.flowMinCfs = v), onChange);
  bindRange($, "su-flowmax", (v) => (state.flowMaxCfs = v), onChange);
  bindRange($, "su-temp", (v) => (state.tempMaxF = v), onChange);
  if (has.access) $("su-access").addEventListener("change", (e) => { state.requirePublicAccess = e.target.checked; onChange(); });

  return { el, setSummary: (t) => ($("su-summary").textContent = t) };
}

function row(label, id, value, min, max, step) {
  return `<label class="range">
    <span>${label}: <b id="${id}-val">${value}</b></span>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" />
  </label>`;
}

function bindRange($, id, set, onChange) {
  const input = $(id);
  if (!input) return;
  input.addEventListener("input", (e) => {
    const v = Number(e.target.value);
    set(v);
    const out = $(id + "-val");
    if (out) out.textContent = v;
    onChange();
  });
}
