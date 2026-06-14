#!/usr/bin/env python3
"""
Create the three editable hosted feature layers this app needs:

    1. BMI Sample Sites      (points)   — benthic macroinvertebrate sampling
    2. Stream Health Readings (points)  — water-quality monitoring
    3. Road Closures & Access (lines)   — published vs. field-verified condition

Schemas here MUST match src/config.js. After it runs, it prints the three
FeatureServer/0 URLs — paste each into the matching LAYERS.*.url in config.js.

Editor tracking is enabled, so "created/edited by + when" are filled
automatically (this is what powers the road-override audit trail).

────────────────────────────────────────────────────────────────────────────
SETUP
    python3 -m venv .venv && source .venv/bin/activate
    pip install arcgis            # Esri's ArcGIS API for Python

RUN  (interactive login — opens a browser, no password stored)
    python scripts/create_layers.py

    or with explicit creds:
    python scripts/create_layers.py --url https://www.arcgis.com --user YOURNAME

This creates items in YOUR content. It does not touch the read-only CA Streams
layer. Re-running detects existing services by name and skips them.
────────────────────────────────────────────────────────────────────────────
"""
import argparse
import sys

try:
    from arcgis.gis import GIS
    from arcgis.features import FeatureLayerCollection
except ImportError:
    sys.exit("Missing dependency. Run:  pip install arcgis")

# California-ish default extent (Web Mercator) so the layers have a sane extent.
CA_EXTENT = {
    "xmin": -13900000, "ymin": 3800000, "xmax": -12900000, "ymax": 5300000,
    "spatialReference": {"wkid": 102100, "latestWkid": 3857},
}
SR = {"wkid": 102100, "latestWkid": 3857}


# ── Field helpers ────────────────────────────────────────────────────────────
def s(name, alias, length=255):
    return {"name": name, "type": "esriFieldTypeString", "alias": alias,
            "length": length, "nullable": True, "editable": True}

def i(name, alias):
    return {"name": name, "type": "esriFieldTypeInteger", "alias": alias,
            "nullable": True, "editable": True}

def d(name, alias):
    return {"name": name, "type": "esriFieldTypeDouble", "alias": alias,
            "nullable": True, "editable": True}

def dt(name, alias):
    return {"name": name, "type": "esriFieldTypeDate", "alias": alias,
            "nullable": True, "editable": True, "length": 8}

OID = {"name": "OBJECTID", "type": "esriFieldTypeOID", "alias": "OBJECTID",
       "nullable": False, "editable": False}


# ── Layer definitions (mirror src/config.js) ─────────────────────────────────
def layer_def(name, geom, fields, renderer=None):
    return {
        "name": name,
        "type": "Feature Layer",
        "geometryType": geom,
        "objectIdField": "OBJECTID",
        "displayField": fields[1]["name"] if len(fields) > 1 else "OBJECTID",
        "fields": [OID] + fields,
        "extent": CA_EXTENT,
        "spatialReference": SR,
        "hasAttachments": True,
        "hasStaticData": False,
        "capabilities": "Create,Delete,Query,Update,Editing,Extract,Sync",
        # Editor tracking → auto "who/when" stamps.
        "editFieldsInfo": {
            "creationDateField": "CreationDate",
            "creatorField": "Creator",
            "editDateField": "EditDate",
            "editorField": "Editor",
        },
        **({"drawingInfo": {"renderer": renderer}} if renderer else {}),
    }


def point_renderer(rgb):
    return {"type": "simple", "symbol": {
        "type": "esriSMS", "style": "esriSMSCircle", "size": 8,
        "color": rgb + [255], "outline": {"color": [255, 255, 255, 255], "width": 1}}}


LAYERS = [
    layer_def(
        "BMI Sample Sites", "esriGeometryPoint",
        [s("site_name", "Site name"), dt("sample_date", "Sample date"),
         i("ept_richness", "EPT richness"), d("biotic_index", "Biotic index"),
         d("csci_score", "CSCI score"), s("taxa_notes", "Taxa notes", 1000)],
        point_renderer([34, 139, 34])),
    layer_def(
        "Stream Health Readings", "esriGeometryPoint",
        [s("station_id", "Station ID"), dt("reading_date", "Reading date"),
         d("temp_f", "Temp (F)"), d("do_mgl", "DO (mg/L)"),
         d("turbidity_ntu", "Turbidity (NTU)"), d("ph", "pH"),
         d("conductivity_uscm", "Conductivity (uS/cm)")],
        point_renderer([30, 144, 255])),
    layer_def(
        "Road Closures & Access", "esriGeometryPolyline",
        [s("route_name", "Route name"), s("published_status", "Published status"),
         s("field_status", "Field-verified status"), s("verified_by", "Verified by"),
         dt("verified_date", "Verified date"), s("condition_notes", "Condition notes", 1000)]),
]

# Each service: (item title, tags, the layer def above)
SERVICES = [
    ("CA_Rivers_BMI_Sites", "BMI Sample Sites", LAYERS[0]),
    ("CA_Rivers_Stream_Health", "Stream Health Readings", LAYERS[1]),
    ("CA_Rivers_Road_Access", "Road Closures & Access", LAYERS[2]),
]

CONFIG_KEY = {  # maps service → the LAYERS.* key in config.js, for the printout
    "CA_Rivers_BMI_Sites": "bmi",
    "CA_Rivers_Stream_Health": "health",
    "CA_Rivers_Road_Access": "roads",
}


def find_existing(gis, service_name):
    hits = gis.content.search(f'title:"{service_name}" type:"Feature Service" owner:{gis.users.me.username}')
    for h in hits:
        if h.title == service_name:
            return h
    return None


def create_service(gis, service_name, friendly, lyr):
    existing = find_existing(gis, service_name)
    if existing:
        print(f"  • {service_name}: already exists — skipping (item {existing.id})")
        item = existing
    else:
        print(f"  • {service_name}: creating…")
        item = gis.content.create_service(
            name=service_name, service_type="featureService",
            has_static_data=False, tags="ca-rivers,fly-fishing,stream-health",
            snippet=f"{friendly} — created by ca-rivers-flyfishing app")
        flc = FeatureLayerCollection.fromitem(item)
        # Enable editor tracking at the service level, then add the layer.
        flc.manager.update_definition({
            "editorTrackingInfo": {
                "enableEditorTracking": True,
                "enableOwnershipAccessControl": False,
                "allowOthersToUpdate": True,
                "allowOthersToDelete": True,
            }
        })
        flc.manager.add_to_definition({"layers": [lyr]})
    return item


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://www.arcgis.com")
    ap.add_argument("--user", default=None, help="username; omit for interactive/OAuth login")
    args = ap.parse_args()

    print(f"Signing in to {args.url} …")
    gis = GIS(args.url, username=args.user) if args.user else GIS(args.url)
    print(f"Signed in as: {gis.users.me.username}\n")

    print("Creating layers:")
    results = []
    for service_name, friendly, lyr in SERVICES:
        item = create_service(gis, service_name, friendly, lyr)
        url = item.layers[0].url if item.layers else f"{item.url}/0"
        results.append((CONFIG_KEY[service_name], url))

    print("\n" + "=" * 72)
    print("DONE. Paste these into src/config.js → LAYERS.<key>.url :\n")
    for key, url in results:
        print(f'  LAYERS.{key}.url = "{url}"')
    print("=" * 72)
    print("\nThen reload the app — editing + closure-aware routing light up.")


if __name__ == "__main__":
    main()
