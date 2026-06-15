#!/usr/bin/env python3
"""
DENSE flow estimate for the enriched streams, from NHDPlus drainage area.

Authoritative modeled flow (NHDPlus EROM mean-annual-flow) has no clean public
API — it only ships in the per-VPU NHDPlus EROMMA download. As a dense stand-in,
this estimates mean flow from TOTAL UPSTREAM DRAINAGE AREA (the dominant control
on flow): Q_cfs ≈ totdasqkm × C, with C ≈ 0.4 cfs per sq km (~1 cfs/sq mi, a
SoCal front-range surrogate — tune for your basin).

Per reach:  mouth point → NLDI COMID → totdasqkm (ENHD parquet) → Q estimate,
then applyEdits UPDATE flow_cfs on CA_Streams_Enriched. Covers every reach that
resolves a COMID (unlike the gage proxy, which only hits reaches near a gage).

It's an ESTIMATE, clearly — swap in EROMMA for authoritative values when you have
the NHDPlus download.

SETUP
    pip install requests duckdb
    # one-time: download the ENHD attributes parquet (~170 MB) that carries totdasqkm
    curl -L "https://www.sciencebase.gov/catalog/file/get/63cb311ed34e06fef14f40a3?f=__disk__fa%2Fb9%2F03%2Ffab9035a4ece1500fdb1ead631a9f364d34d1e30" -o enhd_nhdplusatts.parquet
RUN
    export ARCGIS_TOKEN="<TroutBookDev portal token>"
    python scripts/flow_from_drainage.py --parquet enhd_nhdplusatts.parquet
"""
import argparse, json, os, sys, time
try:
    import requests, duckdb
except ImportError:
    sys.exit("Run: pip install requests duckdb")

ENR = "https://services8.arcgis.com/GfY0eEKd00oAzkH5/arcgis/rest/services/CA_Streams_Enriched/FeatureServer/0"
SRC = "https://services2.arcgis.com/Uq9r85Potqm3MfRV/ArcGIS/rest/services/CA_Streams_wm/FeatureServer/0"
NLDI = "https://api.water.usgs.gov/nldi/linked-data/comid/position"
TOKEN = os.environ.get("ARCGIS_TOKEN", "")
REFERER = os.environ.get("ARCGIS_REFERER", "http://localhost:5173")
CFS_PER_SQKM = 0.4  # ~1 cfs/sq mi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="enhd_nhdplusatts.parquet", help="ENHD attributes parquet (has totdasqkm)")
    ap.add_argument("--coef", type=float, default=CFS_PER_SQKM)
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

    con = duckdb.connect()
    ups, hits = [], 0
    for oid, dfg in reaches:
        ll = mouth.get(dfg)
        if not ll or ll[0] is None:
            continue
        try:
            pos = s.get(NLDI, params={"coords": f"POINT({ll[0]} {ll[1]})", "f": "json"}, timeout=30).json()
            comid = int(pos["features"][0]["properties"]["comid"])
            da = con.execute(f"SELECT totdasqkm FROM '{args.parquet}' WHERE comid=?", [comid]).fetchone()
            if da and da[0]:
                ups.append({"attributes": {"OBJECTID": oid, "flow_cfs": round(da[0] * args.coef, 1)}})
                hits += 1
        except Exception:
            pass
        time.sleep(0.08)

    r = gj(ENR + "/applyEdits", {"updates": json.dumps(ups)}, post=True)
    print(f"DA-flow resolved {hits}/{len(reaches)} | updated {len(r.get('updateResults', []))} | err {r.get('error')}")


if __name__ == "__main__":
    main()
