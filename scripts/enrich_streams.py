#!/usr/bin/env python3
"""
Enrich CA stream reaches with fly-fishing attributes the base layer lacks.

Your CA_Streams layer (740k reaches) is pure CDFW/NHD hydrography — no gradient,
flow, or temperature. This script derives them onto a NEW layer you own
(CA_Streams_Enriched), so the suitability filter + score gradient light up.

It writes:
    gradient_pct  — % slope, from USGS 3DEP elevation at the reach endpoints  [FULLY IMPLEMENTED]
    flow_cfs      — recent mean discharge at the nearest downstream USGS gage  [USGS NLDI+NWIS proxy]
    temp_f        — left null (wire NorWeST stream-temp model later)
    public_access — left null (wire PAD-US / CPAD land-ownership overlay later)
plus the join keys (NHD/GNIS/DFG ids) and the reach Name.

Because 740k reaches is impractical to process at once, you SCOPE each run:
    --bbox  W,S,E,N         only reaches intersecting this lon/lat box (default: Tahoe/Truckee)
    --where "<SQL>"         e.g. "Name IS NOT NULL"  (named reaches only — what anglers care about)
    --limit N               cap features this run (default 500)
It's resumable: already-enriched DFGWATERIDs are skipped on re-run.

After config.js suitability fields are pointed at this layer (gradient_pct / flow_cfs),
the app colors reaches by suitability.

────────────────────────────────────────────────────────────────────────────
SETUP   pip install requests           (lightweight — NOT the full arcgis SDK)
AUTH    A user token for the TroutBookDev org. Grab the "Temporary Token" from
        the OAuth item page (location.arcgis.com dashboard → the OAuth cred →
        item → Credentials → Temporary Token), then:
            export ARCGIS_TOKEN="<paste>"
RUN     python scripts/enrich_streams.py --where "Name IS NOT NULL" --limit 500
────────────────────────────────────────────────────────────────────────────
"""
import argparse, json, math, os, sys, time
try:
    import requests
except ImportError:
    sys.exit("Missing dependency. Run:  pip install requests")

# ── Config ───────────────────────────────────────────────────────────────────
PORTAL = "https://troutbook.maps.arcgis.com/sharing/rest"
USER = "TroutBookDev"
SOURCE = "https://services2.arcgis.com/Uq9r85Potqm3MfRV/ArcGIS/rest/services/CA_Streams_wm/FeatureServer/0"
ENRICHED_NAME = "CA_Streams_Enriched"
EPQS = "https://epqs.nationalmap.gov/v1/json"           # USGS 3DEP point elevation
NLDI = "https://api.water.usgs.gov/nldi/linked-data"    # comid lookup + downstream nav
NWIS_DV = "https://waterservices.usgs.gov/nwis/dv/"     # daily mean discharge
DEFAULT_BBOX = (-120.35, 39.10, -119.90, 39.45)         # Tahoe / Truckee
TOKEN = os.environ.get("ARCGIS_TOKEN", "")

SESSION = requests.Session()
# Browser-OAuth tokens are referer-restricted to the app origin. ArcGIS validates
# the Referer header, so send the registered one or the token is rejected (498).
# Override with ARCGIS_REFERER if your token was minted for a different origin.
SESSION.headers.update({"Referer": os.environ.get("ARCGIS_REFERER", "http://localhost:5173")})


def die(msg): sys.exit("ERROR: " + msg)


def rest(url, params, method="GET"):
    params = {**params, "f": "json", "token": TOKEN}
    r = SESSION.request(method, url, **({"params": params} if method == "GET" else {"data": params}), timeout=60)
    j = r.json()
    if isinstance(j, dict) and j.get("error"):
        die(f"{url} → {j['error'].get('message')} [{j['error'].get('code')}]")
    return j


# ── 1) Ensure the enriched layer exists (create once) ────────────────────────
def ensure_enriched():
    hits = rest(f"{PORTAL}/search", {"q": f'title:"{ENRICHED_NAME}" type:"Feature Service" owner:{USER}'})
    for it in hits.get("results", []):
        if it["title"] == ENRICHED_NAME:
            svc = it["url"]
            print(f"  • enriched layer exists: {svc}/0")
            return svc + "/0"

    print(f"  • creating {ENRICHED_NAME} …")
    create = rest(f"{PORTAL}/content/users/{USER}/createService", {
        "createParameters": json.dumps({
            "name": ENRICHED_NAME,
            "spatialReference": {"wkid": 102100, "latestWkid": 3857},
            "capabilities": "Create,Delete,Query,Update,Editing,Extract,Sync",
            "hasStaticData": False, "maxRecordCount": 2000, "supportedQueryFormats": "JSON",
            "allowGeometryUpdates": True,
        }),
        "targetType": "featureService", "tags": "ca-rivers,enriched,fly-fishing",
    }, method="POST")
    admin = create["serviceurl"].replace("/rest/services/", "/rest/admin/services/")

    def s(n, a, l=255): return {"name": n, "type": "esriFieldTypeString", "alias": a, "length": l, "nullable": True, "editable": True}
    def d(n, a): return {"name": n, "type": "esriFieldTypeDouble", "alias": a, "nullable": True, "editable": True}
    def i(n, a): return {"name": n, "type": "esriFieldTypeInteger", "alias": a, "nullable": True, "editable": True}
    layer = {
        "id": 0, "name": "Enriched Streams", "type": "Feature Layer", "displayField": "Name",
        "geometryType": "esriGeometryPolyline", "objectIdField": "OBJECTID",
        "fields": [
            {"name": "OBJECTID", "type": "esriFieldTypeOID", "alias": "OBJECTID", "nullable": False, "editable": False},
            s("Name", "Name"), i("DFGWATERID", "DFG water id"),
            s("NHD_Permanent_Identifier", "NHD id", 64), s("GNIS_ID", "GNIS id", 32),
            d("gradient_pct", "Gradient (%)"), d("flow_cfs", "Flow (cfs)"),
            d("temp_f", "Temp (F)"), s("public_access", "Public access", 8),
            s("enrich_note", "Enrichment note", 255),
        ],
        "indexes": [], "templates": [], "relationships": [],
        "spatialReference": {"wkid": 102100, "latestWkid": 3857},
        "extent": {"xmin": -13900000, "ymin": 3800000, "xmax": -12900000, "ymax": 5300000,
                   "spatialReference": {"wkid": 102100, "latestWkid": 3857}},
        "hasAttachments": False, "hasM": False, "hasZ": False, "defaultVisibility": True,
        "allowGeometryUpdates": True, "minScale": 0, "maxScale": 0, "maxRecordCount": 2000,
        "supportedQueryFormats": "JSON", "capabilities": "Create,Delete,Query,Update,Editing,Sync",
    }
    rest(f"{admin}/addToDefinition", {"addToDefinition": json.dumps({"layers": [layer]})}, method="POST")
    print("    created.")
    return create["serviceurl"] + "/0"


def already_enriched_ids(enriched_url):
    j = rest(f"{enriched_url}/query", {"where": "1=1", "outFields": "DFGWATERID", "returnGeometry": "false"})
    return {f["attributes"]["DFGWATERID"] for f in j.get("features", [])}


# ── 2) Pull scoped source reaches ────────────────────────────────────────────
def fetch_source(bbox, where, limit):
    params = {
        "where": where or "1=1", "outFields": "DFGWATERID,Name,NHD_Permanent_Identifier,GNIS_ID,Mouth_Lat,Mouth_Long,Shape__Length",
        "returnGeometry": "true", "outSR": 4326, "resultRecordCount": limit,
    }
    if bbox:
        params["geometry"] = json.dumps({"xmin": bbox[0], "ymin": bbox[1], "xmax": bbox[2], "ymax": bbox[3],
                                         "spatialReference": {"wkid": 4326}})
        params["geometryType"] = "esriGeometryEnvelope"; params["spatialRel"] = "esriSpatialRelIntersects"; params["inSR"] = 4326
    return rest(f"{SOURCE}/query", params).get("features", [])


# ── 3) Gradient via 3DEP elevation at endpoints ──────────────────────────────
def elevation_m(lon, lat):
    try:
        r = SESSION.get(EPQS, params={"x": lon, "y": lat, "units": "Meters", "wkid": 4326}, timeout=30)
        v = r.json()["value"]
        return float(v) if v not in (None, "", -1000000) else None
    except Exception:
        return None


def compute_gradient(feat):
    paths = feat.get("geometry", {}).get("paths")
    if not paths or not paths[0]:
        return None, "no geometry"
    line = paths[0]
    (lon_a, lat_a), (lon_b, lat_b) = line[0][:2], line[-1][:2]
    ea, eb = elevation_m(lon_a, lat_a), elevation_m(lon_b, lat_b)
    if ea is None or eb is None:
        return None, "elevation lookup failed"
    length_m = feat["attributes"].get("Shape__Length") or haversine_len(line)
    if not length_m:
        return None, "no length"
    return round(abs(ea - eb) / length_m * 100.0, 3), "ok"


def haversine_len(line):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(line, line[1:]):
        total += _hav(y1, x1, y2, x2)
    return total


def _hav(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dlmb = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ── 4) Flow proxy: nearest downstream USGS gage, recent mean discharge ───────
def compute_flow(feat):
    lon, lat = feat["attributes"].get("Mouth_Long"), feat["attributes"].get("Mouth_Lat")
    if lon is None or lat is None:
        return None, "no mouth coords"
    try:
        # mouth point → COMID
        pos = SESSION.get(f"{NLDI}/comid/position", params={"coords": f"POINT({lon} {lat})", "f": "json"}, timeout=30).json()
        comid = pos["features"][0]["properties"]["comid"]
        # nearest downstream-main gage within 50 km
        gj = SESSION.get(f"{NLDI}/comid/{comid}/navigation/DM/nwissite", params={"distance": 50, "f": "json"}, timeout=30).json()
        feats = gj.get("features") or []
        if not feats:
            return None, "no downstream gage"
        site = feats[0]["properties"]["identifier"].replace("USGS-", "")
        # last ~year of daily mean discharge (param 00060, stat 00003), averaged
        dv = SESSION.get(NWIS_DV, params={"format": "json", "sites": site, "parameterCd": "00060",
                                          "statCd": "00003", "period": "P365D"}, timeout=30).json()
        ts = dv["value"]["timeSeries"]
        vals = [float(v["value"]) for v in ts[0]["values"][0]["value"] if v["value"] not in ("", "-999999")]
        if not vals:
            return None, "no discharge data"
        return round(sum(vals) / len(vals), 1), f"gage {site}"
    except Exception as e:
        return None, f"flow miss ({type(e).__name__})"


# ── 5) Write enriched features ───────────────────────────────────────────────
def to_webmerc(line):
    out = []
    for x, y in [(p[0], p[1]) for p in line]:
        mx = x * 20037508.34 / 180.0
        my = math.log(math.tan((90 + y) * math.pi / 360.0)) / (math.pi / 180.0) * 20037508.34 / 180.0
        out.append([mx, my])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", default=None, help="W,S,E,N lon/lat box (default: Tahoe/Truckee)")
    ap.add_argument("--where", default=None, help='SQL filter, e.g. "Name IS NOT NULL"')
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--no-flow", action="store_true", help="skip flow (gradient only — much faster)")
    args = ap.parse_args()
    if not TOKEN:
        die("Set ARCGIS_TOKEN env var (a TroutBookDev user token). See header.")
    bbox = tuple(map(float, args.bbox.split(","))) if args.bbox else DEFAULT_BBOX

    print("Ensuring enriched layer…")
    enriched = ensure_enriched()
    done = already_enriched_ids(enriched)
    print(f"  • {len(done)} reaches already enriched (will skip)")

    print(f"Fetching source reaches (bbox={bbox}, where={args.where!r}, limit={args.limit})…")
    feats = [f for f in fetch_source(bbox, args.where, args.limit)
             if f["attributes"].get("DFGWATERID") not in done]
    print(f"  • {len(feats)} new reaches to process\n")

    adds, ok, miss = [], 0, 0
    for n, f in enumerate(feats, 1):
        a = f["attributes"]
        grad, gnote = compute_gradient(f)
        flow, fnote = (None, "skipped") if args.no_flow else compute_flow(f)
        if grad is not None:
            ok += 1
        else:
            miss += 1
        adds.append({
            "geometry": {"paths": [to_webmerc(f["geometry"]["paths"][0])], "spatialReference": {"wkid": 102100}},
            "attributes": {
                "Name": a.get("Name"), "DFGWATERID": a.get("DFGWATERID"),
                "NHD_Permanent_Identifier": a.get("NHD_Permanent_Identifier"), "GNIS_ID": a.get("GNIS_ID"),
                "gradient_pct": grad, "flow_cfs": flow, "temp_f": None, "public_access": None,
                "enrich_note": f"grad:{gnote}; flow:{fnote}"[:255],
            },
        })
        print(f"  [{n}/{len(feats)}] {a.get('Name') or a.get('DFGWATERID')}  grad={grad}  flow={flow}")
        # flush every 20 to keep request bodies sane + make it resumable mid-run
        if len(adds) >= 20:
            rest(f"{enriched}/applyEdits", {"adds": json.dumps(adds)}, method="POST")
            adds = []
        time.sleep(0.1)  # be polite to EPQS / NLDI

    if adds:
        rest(f"{enriched}/applyEdits", {"adds": json.dumps(adds)}, method="POST")

    print(f"\nDone. {ok} reaches got gradient, {miss} missed. Layer: {enriched}")
    print("Next: in src/config.js set LAYERS.streams.url to this enriched layer and")
    print("      fields.gradient = 'gradient_pct', fields.flowCfs = 'flow_cfs'. Reload → suitability lights up.")


if __name__ == "__main__":
    main()
