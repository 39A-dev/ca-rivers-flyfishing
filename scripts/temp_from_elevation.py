#!/usr/bin/env python3
"""
DENSE August-mean stream-temperature estimate, from elevation.

Authoritative modeled temp (USFS NorWeST) has no service covering Southern CA —
the national EDW service is defunct and hosted copies are regional (PNW, etc.);
the SoCal unit ships only as a downloadable shapefile. As a dense stand-in, this
estimates August mean stream temp from ELEVATION, which is the dominant control
(cold up high, warm in the canyons):

    T_F ≈ BASE − LAPSE × elevation_ft        (BASE≈80°F, LAPSE≈0.0030 °F/ft)

so ~68°F (the trout-stress line) falls around 4,000 ft — a sensible SoCal trout
elevation. Per reach: mouth point → 3DEP elevation (USGS EPQS) → T estimate, then
applyEdits UPDATE temp_f on CA_Streams_Enriched.

It's an ESTIMATE — swap in NorWeST (download the SoCal processing unit, spatial
join) for authoritative, shading/flow-aware temperatures.

SETUP   pip install requests
RUN     export ARCGIS_TOKEN="<TroutBookDev portal token>"
        python scripts/temp_from_elevation.py
"""
import argparse, json, os, sys, time
try:
    import requests
except ImportError:
    sys.exit("Run: pip install requests")

ENR = "https://services8.arcgis.com/GfY0eEKd00oAzkH5/arcgis/rest/services/CA_Streams_Enriched/FeatureServer/0"
SRC = "https://services2.arcgis.com/Uq9r85Potqm3MfRV/ArcGIS/rest/services/CA_Streams_wm/FeatureServer/0"
EPQS = "https://epqs.nationalmap.gov/v1/json"
TOKEN = os.environ.get("ARCGIS_TOKEN", "")
REFERER = os.environ.get("ARCGIS_REFERER", "http://localhost:5173")
BASE_F, LAPSE_F_PER_FT = 80.0, 0.0030


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=float, default=BASE_F)
    ap.add_argument("--lapse", type=float, default=LAPSE_F_PER_FT)
    args = ap.parse_args()
    if not TOKEN:
        sys.exit("Set ARCGIS_TOKEN (a TroutBookDev portal token).")

    s = requests.Session(); s.headers.update({"Referer": REFERER})
    def gj(url, params, post=False):
        params = {**params, "f": "json", "token": TOKEN}
        r = s.post(url, data=params, timeout=120) if post else s.get(url, params=params, timeout=120)
        return r.json()

    reaches = [(f["attributes"]["OBJECTID"], f["attributes"]["DFGWATERID"])
               for f in gj(ENR + "/query", {"where": "1=1", "outFields": "OBJECTID,DFGWATERID", "returnGeometry": "false"})["features"]]
    ids = ",".join(str(d) for _, d in reaches)
    src = gj(SRC + "/query", {"where": f"DFGWATERID IN ({ids})", "outFields": "DFGWATERID,Mouth_Long,Mouth_Lat", "returnGeometry": "false"})
    mouth = {f["attributes"]["DFGWATERID"]: (f["attributes"]["Mouth_Long"], f["attributes"]["Mouth_Lat"]) for f in src["features"]}

    ups, hits = [], 0
    for oid, dfg in reaches:
        ll = mouth.get(dfg)
        if not ll or ll[0] is None:
            continue
        try:
            v = s.get(EPQS, params={"x": ll[0], "y": ll[1], "units": "Meters", "wkid": 4326}, timeout=30).json()["value"]
            elev_ft = float(v) * 3.28084
            t_f = round(args.base - args.lapse * elev_ft, 1)
            ups.append({"attributes": {"OBJECTID": oid, "temp_f": t_f}})
            hits += 1
        except Exception:
            pass
        time.sleep(0.08)

    r = gj(ENR + "/applyEdits", {"updates": json.dumps(ups)}, post=True)
    print(f"temp resolved {hits}/{len(reaches)} | updated {len(r.get('updateResults', []))} | err {r.get('error')}")


if __name__ == "__main__":
    main()
