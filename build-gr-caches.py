from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent
ROUTES_PATH = ROOT / "cache-routes.json"
METADATA_PATH = ROOT / "cache-route-metadata.json"
ROUTE_CACHE_DIR = ROOT / "route-cache"
ROUTE_MANIFEST_PATH = ROOT / "gr-route-cache-manifest.js"
REGION_CACHE_PATH = ROOT / "gr-region-cache.js"
LOCAL_REGION_DEFS_PATH = ROOT / "region-geometry.js"
REGION_GEOJSON_URL = "https://france-geojson.gregoiredavid.fr/repo/regions.geojson"
FRANCE_AREA = 3602202162
ENDPOINTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
ENDPOINT_CANDIDATES = list(
    dict.fromkeys(
        [
            *[url.replace("https://", "http://", 1) for url in ENDPOINTS],
            *ENDPOINTS,
        ]
    )
)
OVERPASS_RETRY_PASSES = 2
OVERPASS_RETRY_DELAY_SECONDS = 0.4
OVERPASS_ROUTE_FETCH_TIMEOUT_SECONDS = 90
OVERPASS_PLACE_FETCH_TIMEOUT_SECONDS = 45
POWERSHELL_COMMAND = shutil.which("pwsh") or shutil.which("powershell")
BUILD_GENERATED_AT = datetime.now().astimezone().isoformat(timespec="seconds")
METRO_BOUNDS = {
    "min_lat": 41.0,
    "max_lat": 51.5,
    "min_lon": -5.5,
    "max_lon": 9.8,
}
METRO_REGIONS = OrderedDict(
    [
        ("Bretagne", {"code": "BRE", "iso": "FR-BRE"}),
        ("Normandie", {"code": "NOR", "iso": "FR-NOR"}),
        ("Hauts-de-France", {"code": "HDF", "iso": "FR-HDF"}),
        ("Grand Est", {"code": "GES", "iso": "FR-GES"}),
        ("Île-de-France", {"code": "IDF", "iso": "FR-IDF"}),
        ("Pays de la Loire", {"code": "PDL", "iso": "FR-PDL"}),
        ("Centre-Val de Loire", {"code": "CVL", "iso": "FR-CVL"}),
        ("Bourgogne-Franche-Comté", {"code": "BFC", "iso": "FR-BFC"}),
        ("Nouvelle-Aquitaine", {"code": "NAQ", "iso": "FR-NAQ"}),
        ("Occitanie", {"code": "OCC", "iso": "FR-OCC"}),
        ("Auvergne-Rhône-Alpes", {"code": "ARA", "iso": "FR-ARA"}),
        ("Provence-Alpes-Côte d'Azur", {"code": "PAC", "iso": "FR-PAC"}),
        ("Corse", {"code": "COR", "iso": "FR-COR"}),
    ]
)
VARIANT_RE = re.compile(r"alternative|variant|shortcut|excursion|approach|access", re.I)
SKIP_RELATION_RE = re.compile(r"variante|variant|liaison|acc[eè]s|raccourci", re.I)
PLACE_TYPES_RE = re.compile(r"^(city|town|village)$", re.I)
PLACE_PRIORITY = {"city": 0, "town": 1, "village": 2}
PLACE_DISTANCE_LIMITS = {"city": 2500.0, "town": 2200.0, "village": 1800.0}
PLACE_SEARCH_RADIUS_METERS = int(max(PLACE_DISTANCE_LIMITS.values()))
REGION_DEF_RE = re.compile(r"\{\s*code:\s*'([^']+)'[\s\S]*?path:\s*'([^']+)'", re.S)
SVG_PATH_TOKEN_RE = re.compile(r"[MLZ]|-?\d+(?:\.\d+)?")
LOCAL_REGION_MAP_BOUNDS = {
    "min_lon": -5.5,
    "max_lon": 9.8,
    "min_lat": 41.2,
    "max_lat": 51.2,
    "min_x": 18.0,
    "max_x": 342.0,
    "min_y": 145.0,
    "max_y": 358.0,
}
METRO_REGIONS_BY_CODE = {
    meta["code"]: {"name": name, "iso": meta["iso"]}
    for name, meta in METRO_REGIONS.items()
}


def normalize_ref(value: str | None) -> str:
    return re.sub(r"\s+", "", str(value or "")).upper()


def sort_ref_key(value: str) -> tuple[int, str]:
    match = re.search(r"(\d+)", value or "")
    return (int(match.group(1)) if match else 10**9, value or "")


def escape_overpass_regex(text: str) -> str:
    return re.escape(text)


def haversine(a: list[float], b: list[float]) -> float:
    radius = 6371000
    lat1 = math.radians(a[0])
    lat2 = math.radians(b[0])
    d_lat = math.radians(b[0] - a[0])
    d_lon = math.radians(b[1] - a[1])
    h = math.sin(d_lat / 2) ** 2 + math.sin(d_lon / 2) ** 2 * math.cos(lat1) * math.cos(lat2)
    return 2 * radius * math.asin(math.sqrt(h))


def is_in_metro_france(point: list[float]) -> bool:
    return (
        METRO_BOUNDS["min_lat"] <= point[0] <= METRO_BOUNDS["max_lat"]
        and METRO_BOUNDS["min_lon"] <= point[1] <= METRO_BOUNDS["max_lon"]
    )


def should_clip_to_metro_france(metadata: dict | None) -> bool:
    return metadata.get("clipToMetroFrance", True) is not False if isinstance(metadata, dict) else True


def to_latlngs(geometry: list[dict] | None, metadata: dict | None = None) -> list[list[float]] | None:
    if not isinstance(geometry, list) or len(geometry) < 2:
        return None
    latlngs = [[point["lat"], point["lon"]] for point in geometry if "lat" in point and "lon" in point]
    if len(latlngs) < 2:
        return None
    if should_clip_to_metro_france(metadata) and not any(is_in_metro_france(point) for point in latlngs):
        return None
    return latlngs


def xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def fetch_url_bytes(url: str, timeout_seconds: int = 60) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/gpx+xml, application/xml, text/xml, */*",
            "User-Agent": "gr-cache-builder/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        return response.read()


def normalize_gpx_source_list(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []

    sources: list[dict] = []
    for item in value:
        if isinstance(item, str):
            url = item.strip()
            if url:
                sources.append({"url": url})
            continue

        if not isinstance(item, dict):
            continue

        url = str(item.get("url") or item.get("gpxUrl") or "").strip()
        if not url:
            continue

        source = dict(item)
        source["url"] = url
        sources.append(source)

    return sources


def parse_latlng_pair(value: object) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None

    try:
        return [float(value[0]), float(value[1])]
    except (TypeError, ValueError):
        return None


def flatten_ordered_segments(ordered_segments: list[list[list[float]]]) -> list[list[float]]:
    flattened: list[list[float]] = []

    for segment in ordered_segments:
        for point in segment:
            latlng = list(point)
            if flattened and flattened[-1] == latlng:
                continue
            flattened.append(latlng)

    return flattened


def clip_points_between_anchors(
    points: list[list[float]],
    start_anchor: list[float] | None,
    end_anchor: list[float] | None,
) -> list[list[float]]:
    if len(points) < 2:
        raise RuntimeError("Impossible de découper un GPX vide ou trop court")

    start_index = 0
    end_index = len(points) - 1

    if start_anchor:
        start_index = min(range(len(points)), key=lambda index: haversine(start_anchor, points[index]))
    if end_anchor:
        end_index = min(range(len(points)), key=lambda index: haversine(end_anchor, points[index]))

    if end_index < start_index:
        clipped = list(reversed(points[end_index : start_index + 1]))
    else:
        clipped = points[start_index : end_index + 1]

    if len(clipped) < 2:
        raise RuntimeError("La découpe GPX a produit un segment inexploitable")

    return [list(point) for point in clipped]


def apply_gpx_source_clip(extracted: dict, gpx_source: dict | None = None) -> dict:
    if not isinstance(extracted, dict) or not isinstance(gpx_source, dict):
        return extracted

    start_anchor = parse_latlng_pair(gpx_source.get("clipStartNear"))
    end_anchor = parse_latlng_pair(gpx_source.get("clipEndNear"))
    if not start_anchor and not end_anchor:
        return extracted

    ordered_segments = extracted.get("ordered_segments")
    if not isinstance(ordered_segments, list) or not ordered_segments:
        return extracted

    clipped_segment = clip_points_between_anchors(
        flatten_ordered_segments(ordered_segments),
        start_anchor,
        end_anchor,
    )

    updated = dict(extracted)
    updated["ordered_segments"] = [clipped_segment]
    updated["chain_count"] = 1
    updated["max_join_gap"] = 0.0
    updated["raw_segment_count"] = 1
    return updated


def extract_segments_from_gpx(gpx_bytes: bytes, metadata: dict | None = None) -> dict:
    try:
        root = ET.fromstring(gpx_bytes)
    except ET.ParseError as error:
        raise RuntimeError(f"GPX invalide: {error}") from error

    segments: list[list[list[float]]] = []

    for track_segment in root.iter():
        if xml_local_name(track_segment.tag) != "trkseg":
            continue

        segment: list[list[float]] = []
        for point in track_segment:
            if xml_local_name(point.tag) != "trkpt":
                continue

            try:
                latlng = [float(point.attrib["lat"]), float(point.attrib["lon"])]
            except (KeyError, TypeError, ValueError):
                continue

            if should_clip_to_metro_france(metadata) and not is_in_metro_france(latlng):
                continue
            segment.append(latlng)

        if len(segment) >= 2:
            segments.append(segment)

    if not segments:
        route_points: list[list[float]] = []
        for route_point in root.iter():
            if xml_local_name(route_point.tag) != "rtept":
                continue

            try:
                latlng = [float(route_point.attrib["lat"]), float(route_point.attrib["lon"])]
            except (KeyError, TypeError, ValueError):
                continue

            if should_clip_to_metro_france(metadata) and not is_in_metro_france(latlng):
                continue
            route_points.append(latlng)

        if len(route_points) >= 2:
            segments.append(route_points)

    if not segments:
        raise RuntimeError("Aucun segment exploitable dans le GPX")

    oriented = orient_segments(segments)
    oriented["raw_segment_count"] = len(segments)
    return oriented


def extract_segments_from_gpx_source(gpx_source: dict, metadata: dict | None = None) -> tuple[dict, str]:
    source_url = str(gpx_source.get("url") or "").strip()
    if not source_url:
        raise RuntimeError("Source GPX sans URL")

    source_metadata = dict(metadata) if isinstance(metadata, dict) else {}
    for key, value in gpx_source.items():
        if key == "url":
            continue
        source_metadata[key] = value

    extracted = apply_join_gap_threshold(
        extract_segments_from_gpx(fetch_url_bytes(source_url), source_metadata),
        source_metadata,
    )
    extracted = apply_gpx_source_clip(extracted, gpx_source)
    return extracted, source_url


def point_key(point: list[float]) -> str:
    return f"{point[0]:.4f}:{point[1]:.4f}"


def orient_segments_in_current_order(segments: list[list[list[float]]]) -> dict:
    if not segments:
        return {"ordered_segments": [], "max_join_gap": 0.0}

    ordered_segments = [list(segments[0])]
    previous_end = ordered_segments[0][-1]
    max_join_gap = 0.0

    for segment in segments[1:]:
        candidate = list(segment)
        start_gap = haversine(previous_end, candidate[0])
        end_gap = haversine(previous_end, candidate[-1])

        if end_gap < start_gap:
            candidate.reverse()
            max_join_gap = max(max_join_gap, end_gap)
        else:
            max_join_gap = max(max_join_gap, start_gap)

        ordered_segments.append(candidate)
        previous_end = candidate[-1]

    return {"ordered_segments": ordered_segments, "max_join_gap": max_join_gap}


def reorder_segments_by_connectivity(segments: list[list[list[float]]]) -> dict:
    if not segments:
        return {"ordered_segments": [], "max_join_gap": 0.0, "chain_count": 0}

    records = [
        {
            "index": index,
            "points": list(segment),
            "start_key": point_key(segment[0]),
            "end_key": point_key(segment[-1]),
        }
        for index, segment in enumerate(segments)
    ]
    adjacency: dict[str, list[int]] = {}
    ordered_segments: list[list[list[float]]] = []
    used: set[int] = set()
    chain_count = 0

    def add_adjacency(key: str, record_index: int) -> None:
        adjacency.setdefault(key, []).append(record_index)

    for record_index, record in enumerate(records):
        add_adjacency(record["start_key"], record_index)
        add_adjacency(record["end_key"], record_index)

    def endpoint_degree(key: str) -> int:
        return len(adjacency.get(key, []))

    def next_seed_index() -> int:
        for index, record in enumerate(records):
            if index in used:
                continue
            if endpoint_degree(record["start_key"]) == 1 or endpoint_degree(record["end_key"]) == 1:
                return index
        for index in range(len(records)):
            if index not in used:
                return index
        return -1

    def take_connected_segment(anchor_key: str, attach_to_start: bool) -> list[list[float]] | None:
        candidates = sorted(index for index in adjacency.get(anchor_key, []) if index not in used)
        if not candidates:
            return None

        chosen_index = candidates[0]
        chosen = records[chosen_index]
        points = list(chosen["points"])
        first_key = point_key(points[0])
        last_key = point_key(points[-1])

        if attach_to_start:
            if last_key != anchor_key and first_key == anchor_key:
                points.reverse()
        elif first_key != anchor_key and last_key == anchor_key:
            points.reverse()

        used.add(chosen_index)
        return points

    while len(used) < len(records):
        seed_index = next_seed_index()
        if seed_index == -1:
            break

        seed = records[seed_index]
        chain = list(seed["points"])
        used.add(seed_index)
        chain_count += 1

        if endpoint_degree(seed["start_key"]) != 1 and endpoint_degree(seed["end_key"]) == 1:
            chain.reverse()

        extended = True
        while extended:
            extended = False
            nxt = take_connected_segment(point_key(chain[-1]), False)
            if nxt:
                chain.extend(nxt[1:])
                extended = True

        extended = True
        while extended:
            extended = False
            previous = take_connected_segment(point_key(chain[0]), True)
            if previous:
                chain = previous[:-1] + chain
                extended = True

        ordered_segments.append(chain)

    return {"ordered_segments": ordered_segments, "max_join_gap": 0.0, "chain_count": chain_count}


def orient_segments(segments: list[list[list[float]]]) -> dict:
    relation_ordered = orient_segments_in_current_order(segments)
    if relation_ordered["max_join_gap"] <= 1000:
        return {
            "ordered_segments": relation_ordered["ordered_segments"],
            "max_join_gap": relation_ordered["max_join_gap"],
            "chain_count": 1 if relation_ordered["ordered_segments"] else 0,
        }

    connectivity_ordered = reorder_segments_by_connectivity(segments)
    reoriented = orient_segments_in_current_order(connectivity_ordered["ordered_segments"])
    return {
        "ordered_segments": reoriented["ordered_segments"],
        "max_join_gap": reoriented["max_join_gap"],
        "chain_count": connectivity_ordered["chain_count"],
    }


def should_skip_member(member: dict) -> bool:
    return bool(VARIANT_RE.search(member.get("role", "")))


def should_skip_relation(relation: dict, display_name: str) -> bool:
    tags = relation.get("tags", {})
    route_text = " ".join(value for value in [tags.get("name"), tags.get("from"), tags.get("to")] if value)
    if not route_text:
        return False
    if re.search(r"variante", display_name, re.I):
        return False
    return bool(SKIP_RELATION_RE.search(route_text))


def extract_segments(data: dict, display_name: str, metadata: dict | None = None) -> dict:
    elements = data.get("elements", [])
    relations_by_id = {element["id"]: element for element in elements if element.get("type") == "relation"}
    ways_by_id = {element["id"]: element for element in elements if element.get("type") == "way"}
    seen_way_ids: set[int] = set()

    child_relation_ids: set[int] = set()
    for relation in relations_by_id.values():
        for member in relation.get("members", []):
            if member.get("type") == "relation":
                child_relation_ids.add(member.get("ref"))

    root_relations = [
        element
        for element in elements
        if element.get("type") == "relation" and element.get("id") not in child_relation_ids
    ]
    visited_relations: set[int] = set()
    segments: list[list[list[float]]] = []

    def visit_relation(relation: dict | None) -> None:
        if not relation:
            return
        relation_id = relation.get("id")
        if relation_id in visited_relations:
            return

        visited_relations.add(relation_id)
        for member in relation.get("members", []):
            if should_skip_member(member):
                continue
            if member.get("type") == "relation":
                child_relation = relations_by_id.get(member.get("ref"))
                if child_relation and should_skip_relation(child_relation, display_name):
                    continue
                visit_relation(child_relation)
                continue
            if member.get("type") != "way":
                continue

            way_id = member.get("ref")
            if way_id in seen_way_ids:
                continue

            geometry = member.get("geometry") or ways_by_id.get(way_id, {}).get("geometry")
            latlngs = to_latlngs(geometry, metadata)
            if latlngs:
                seen_way_ids.add(way_id)
                segments.append(latlngs)

    preferred_roots = [relation for relation in root_relations if not should_skip_relation(relation, display_name)]
    for relation in preferred_roots or root_relations:
        visit_relation(relation)

    if not segments:
        for element in elements:
            if element.get("type") != "way":
                continue
            way_id = element.get("id")
            if way_id in seen_way_ids:
                continue
            latlngs = to_latlngs(element.get("geometry"), metadata)
            if latlngs:
                seen_way_ids.add(way_id)
                segments.append(latlngs)

    oriented = orient_segments(segments)
    oriented["raw_segment_count"] = len(segments)
    return oriented


def build_name_search_regex(display_name: str, metadata: dict) -> str | None:
    patterns = metadata.get("namePatterns") if isinstance(metadata.get("namePatterns"), list) else None
    if patterns:
        return "|".join(patterns)

    cleaned_name = re.sub(r"\([^)]*\)", "", display_name).strip()
    if len(cleaned_name) < 4:
        return None
    return escape_overpass_regex(cleaned_name)


def build_osmc_symbol_regex(num: str, metadata: dict) -> str | None:
    patterns = metadata.get("osmcSymbolPatterns") if isinstance(metadata.get("osmcSymbolPatterns"), list) else None
    if patterns:
        return "|".join(patterns)
    if not num:
        return None
    return rf"red::white_upper:red_lower:{escape_overpass_regex(num)}:black$"


def normalize_relation_id_list(value: object) -> list[int] | None:
    if not isinstance(value, list) or not value:
        return None

    normalized: list[int] = []
    for item in value:
        if isinstance(item, int):
            normalized.append(item)
            continue
        if isinstance(item, str) and item.isdigit():
            normalized.append(int(item))
            continue
        return None

    return normalized


def build_relation_geometry_query(relation_ids: list[int]) -> str:
    relation_ids_text = ",".join(str(value) for value in relation_ids)
    return (
        f"""
[out:json][timeout:120];
relation(id:{relation_ids_text})->.matched;
(
  .matched;
  >>;
);
out geom;
""".strip()
    )


def build_relation_place_query(relation_ids: list[int]) -> str:
    relation_ids_text = ",".join(str(value) for value in relation_ids)
    return (
        f"""
[out:json][timeout:120];
relation(id:{relation_ids_text})->.matched;
(
    .matched;
    >>;
)->.expanded;
way.expanded->.routeWays;
node(around.routeWays:{PLACE_SEARCH_RADIUS_METERS})["place"~"^(city|town|village)$", i];
out body;
""".strip()
    )


def compose_ordered_segments(segment_groups: list[list[list[list[float]]]]) -> dict:
    ordered_segments: list[list[list[float]]] = []
    max_join_gap = 0.0
    chain_count = 0

    def find_next_segment(group_index: int, segment_index: int) -> list[list[float]] | None:
        for next_group_index in range(group_index, len(segment_groups)):
            next_segment_index = segment_index + 1 if next_group_index == group_index else 0
            for next_segment in segment_groups[next_group_index][next_segment_index:]:
                if next_segment:
                    return next_segment
        return None

    for group_index, segment_group in enumerate(segment_groups):
        for segment_index, segment in enumerate(segment_group):
            candidate = list(segment)
            if not candidate:
                continue

            if not ordered_segments:
                next_segment = find_next_segment(group_index, segment_index)
                if next_segment:
                    reversed_candidate = list(reversed(candidate))
                    next_start = next_segment[0]
                    next_end = next_segment[-1]
                    candidate_end_gap = min(
                        haversine(candidate[-1], next_start),
                        haversine(candidate[-1], next_end),
                    )
                    reversed_end_gap = min(
                        haversine(reversed_candidate[-1], next_start),
                        haversine(reversed_candidate[-1], next_end),
                    )
                    if reversed_end_gap < candidate_end_gap:
                        candidate = reversed_candidate

                ordered_segments.append(candidate)
                chain_count = 1
                continue

            previous_end = ordered_segments[-1][-1]
            start_gap = haversine(previous_end, candidate[0])
            end_gap = haversine(previous_end, candidate[-1])

            if end_gap < start_gap:
                candidate.reverse()
                join_gap = end_gap
            else:
                join_gap = start_gap

            max_join_gap = max(max_join_gap, join_gap)
            if join_gap > 1000:
                chain_count += 1

            ordered_segments.append(candidate)

    return {
        "ordered_segments": ordered_segments,
        "max_join_gap": max_join_gap,
        "chain_count": chain_count,
    }


def collapse_ordered_segment_group(segment_group: list[list[list[float]]]) -> list[list[float]]:
    collapsed: list[list[float]] = []

    for segment in segment_group:
        candidate = list(segment)
        if not candidate:
            continue

        if not collapsed:
            collapsed = candidate
            continue

        start_gap = haversine(collapsed[-1], candidate[0])
        end_gap = haversine(collapsed[-1], candidate[-1])
        if end_gap < start_gap:
            candidate.reverse()

        collapsed.extend(candidate[1:])

    return collapsed


def apply_join_gap_threshold(extracted: dict, metadata: dict | None = None) -> dict:
    if not isinstance(extracted, dict) or not isinstance(metadata, dict):
        return extracted

    try:
        join_gap_threshold = float(metadata.get("joinGapsUnderMeters") or 0)
    except (TypeError, ValueError):
        return extracted

    ordered_segments = extracted.get("ordered_segments")
    if join_gap_threshold <= 0 or not isinstance(ordered_segments, list) or len(ordered_segments) < 2:
        return extracted

    merged_segments: list[list[list[float]]] = []
    current_segment: list[list[float]] = []
    remaining_max_gap = 0.0

    for segment in ordered_segments:
        candidate = list(segment)
        if not candidate:
            continue

        if not current_segment:
            current_segment = candidate
            continue

        join_gap = haversine(current_segment[-1], candidate[0])
        if join_gap <= join_gap_threshold:
            if join_gap <= 1e-6:
                current_segment.extend(candidate[1:])
            else:
                current_segment.extend(candidate)
            continue

        remaining_max_gap = max(remaining_max_gap, join_gap)
        merged_segments.append(current_segment)
        current_segment = candidate

    if current_segment:
        merged_segments.append(current_segment)

    updated = dict(extracted)
    updated["ordered_segments"] = merged_segments
    updated["chain_count"] = len(merged_segments)
    updated["max_join_gap"] = remaining_max_gap
    return updated


def build_queries(ref: str, display_name: str, metadata: dict) -> list[str]:
    num = re.sub(r"^GR\s*", "", ref, flags=re.I)
    ref_regex = rf"^GR ?0*{num}$"
    name_search_regex = build_name_search_regex(display_name, metadata)
    osmc_symbol_regex = build_osmc_symbol_regex(num, metadata)
    relation_id = metadata.get("relationId")
    relation_ids = normalize_relation_id_list(metadata.get("relationIds"))

    queries: list[str] = []
    if relation_id:
        queries.append(build_relation_geometry_query([relation_id]))
    if relation_ids:
        queries.append(build_relation_geometry_query(relation_ids))

    queries.append(
        f"""
[out:json][timeout:120];
area({FRANCE_AREA})->.fr;
(
  relation["route"="hiking"]["network"="nwn"]["ref"~"{ref_regex}"](area.fr);
  relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["ref"~"{ref_regex}"](area.fr);
)->.matched;
rel(br.matched)["type"="superroute"]["route"="hiking"]["network"="nwn"]["ref"~"{ref_regex}"]->.parentSuperroutes;
(
  .matched;
  .parentSuperroutes;
)->.allMatched;
(
  .allMatched;
  >>;
);
out geom;
""".strip()
    )

    if osmc_symbol_regex:
        queries.append(
            f"""
[out:json][timeout:120];
area({FRANCE_AREA})->.fr;
(
  relation["route"="hiking"]["network"="nwn"]["osmc:symbol"~"{osmc_symbol_regex}", i](area.fr);
  relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["osmc:symbol"~"{osmc_symbol_regex}", i](area.fr);
)->.matched;
rel(br.matched)["type"="superroute"]["route"="hiking"]["network"="nwn"]->.parentSuperroutes;
(
  .matched;
  .parentSuperroutes;
)->.allMatched;
(
  .allMatched;
  >>;
);
out geom;
""".strip()
        )

    if name_search_regex:
        queries.append(
            f"""
[out:json][timeout:120];
area({FRANCE_AREA})->.fr;
(
  relation["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
  relation["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i][!"ref"](area.fr);
  relation["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
  relation["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i][!"ref"](area.fr);
  relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
  relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i][!"ref"](area.fr);
  relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
  relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i][!"ref"](area.fr);
)->.matched;
rel(br.matched)["type"="superroute"]["route"="hiking"]["network"="nwn"]->.parentSuperroutes;
(
    .matched;
    .parentSuperroutes;
)->.allMatched;
(
    .allMatched;
  >>;
);
out geom;
""".strip()
        )

    return queries


def build_place_queries(ref: str, display_name: str, metadata: dict) -> list[str]:
    num = re.sub(r"^GR\s*", "", ref, flags=re.I)
    ref_regex = rf"^GR ?0*{num}$"
    name_search_regex = build_name_search_regex(display_name, metadata)
    osmc_symbol_regex = build_osmc_symbol_regex(num, metadata)
    relation_id = metadata.get("relationId")
    relation_ids = normalize_relation_id_list(metadata.get("relationIds"))
    ordered_relation_ids = normalize_relation_id_list(metadata.get("orderedRelationIds"))
    place_relation_ids = normalize_relation_id_list(metadata.get("placeRelationIds"))

    queries: list[str] = []
    if relation_id:
        queries.append(build_relation_place_query([relation_id]))
    if relation_ids:
        queries.append(build_relation_place_query(relation_ids))
    if ordered_relation_ids:
        queries.append(build_relation_place_query(ordered_relation_ids))
    if place_relation_ids:
        queries.append(build_relation_place_query(place_relation_ids))

    queries.append(
        f"""
[out:json][timeout:120];
area({FRANCE_AREA})->.fr;
(
    relation["route"="hiking"]["network"="nwn"]["ref"~"{ref_regex}"](area.fr);
    relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["ref"~"{ref_regex}"](area.fr);
)->.matched;
rel(br.matched)["type"="superroute"]["route"="hiking"]["network"="nwn"]["ref"~"{ref_regex}"]->.parentSuperroutes;
(
    .matched;
    .parentSuperroutes;
)->.allMatched;
(
    .allMatched;
    >>;
)->.expanded;
way.expanded->.routeWays;
node(around.routeWays:{PLACE_SEARCH_RADIUS_METERS})["place"~"^(city|town|village)$", i];
out body;
""".strip()
    )

    if osmc_symbol_regex:
        queries.append(
            f"""
[out:json][timeout:120];
area({FRANCE_AREA})->.fr;
(
    relation["route"="hiking"]["network"="nwn"]["osmc:symbol"~"{osmc_symbol_regex}", i](area.fr);
    relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["osmc:symbol"~"{osmc_symbol_regex}", i](area.fr);
)->.matched;
rel(br.matched)["type"="superroute"]["route"="hiking"]["network"="nwn"]->.parentSuperroutes;
(
    .matched;
    .parentSuperroutes;
)->.allMatched;
(
    .allMatched;
    >>;
)->.expanded;
way.expanded->.routeWays;
node(around.routeWays:{PLACE_SEARCH_RADIUS_METERS})["place"~"^(city|town|village)$", i];
out body;
""".strip()
        )

    if name_search_regex:
        queries.append(
            f"""
[out:json][timeout:120];
area({FRANCE_AREA})->.fr;
(
    relation["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
    relation["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i][!"ref"](area.fr);
    relation["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
    relation["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i][!"ref"](area.fr);
    relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
    relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["name"~"{name_search_regex}", i][!"ref"](area.fr);
    relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i]["ref"~"{ref_regex}"](area.fr);
    relation["type"="superroute"]["route"="hiking"]["network"="nwn"]["alt_name"~"{name_search_regex}", i][!"ref"](area.fr);
)->.matched;
(
    .matched;
    >>;
)->.expanded;
way.expanded->.routeWays;
node(around.routeWays:{PLACE_SEARCH_RADIUS_METERS})["place"~"^(city|town|village)$", i];
out body;
""".strip()
        )

    return queries


def sample_route_points_for_place_query(
    segments: list[list[list[float]]],
    spacing_meters: float = 15000.0,
    max_points: int = 36,
) -> list[list[float]]:
    total_distance = compute_total_distance(segments)
    if total_distance > 0:
        spacing_meters = max(spacing_meters, total_distance / max_points)

    sampled_points: list[list[float]] = []
    next_sample_distance = 0.0
    traveled = 0.0

    for segment in segments:
        if not segment:
            continue

        if not sampled_points:
            sampled_points.append(segment[0])

        for index in range(1, len(segment)):
            start = segment[index - 1]
            end = segment[index]
            segment_length = haversine(start, end)
            if segment_length <= 0:
                continue

            while traveled + segment_length >= next_sample_distance:
                ratio = (next_sample_distance - traveled) / segment_length if segment_length else 0.0
                ratio = max(0.0, min(1.0, ratio))
                sampled_points.append(
                    [
                        start[0] + (end[0] - start[0]) * ratio,
                        start[1] + (end[1] - start[1]) * ratio,
                    ]
                )
                next_sample_distance += spacing_meters
                if len(sampled_points) >= max_points:
                    break

            traveled += segment_length
            if len(sampled_points) >= max_points:
                break
        if len(sampled_points) >= max_points:
            break

    sampled_points.append(segments[-1][-1])

    deduped_points: list[list[float]] = []
    seen_keys: set[tuple[float, float]] = set()
    for point in sampled_points:
        point_key = (round(point[0], 4), round(point[1], 4))
        if point_key in seen_keys:
            continue
        seen_keys.add(point_key)
        deduped_points.append(point)

    return deduped_points


def build_sampled_place_query(segments: list[list[list[float]]]) -> str:
    clauses = [
        f'  node(around:{PLACE_SEARCH_RADIUS_METERS},{point[0]:.5f},{point[1]:.5f})["place"~"^(city|town|village)$", i];'
        for point in sample_route_points_for_place_query(segments)
    ]
    return "\n".join(["[out:json][timeout:90];", "(", *clauses, ");", "out body;"])


def fetch_overpass(query_text: str, timeout_seconds: int = 45, require_elements: bool = False) -> tuple[dict, str]:
    last_transport_error: Exception | None = None
    saw_empty_response = False
    payload = urllib.parse.urlencode({"data": query_text}).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Connection": "close",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "gr-cache-builder/1.0",
    }

    def accept_response(data: dict, url: str) -> tuple[dict, str] | None:
        nonlocal saw_empty_response
        if require_elements and not data.get("elements"):
            saw_empty_response = True
            return None
        return data, url

    def fetch_with_powershell(url: str) -> dict:
        if not POWERSHELL_COMMAND:
            raise RuntimeError("PowerShell indisponible")

        env = dict(os.environ)
        env["OVERPASS_QUERY"] = query_text
        env["OVERPASS_TIMEOUT"] = str(timeout_seconds)
        env["OVERPASS_URL"] = url
        command = [
            POWERSHELL_COMMAND,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; $body = 'data=' + [uri]::EscapeDataString($env:OVERPASS_QUERY); $headers = @{ 'User-Agent'='gr-cache-builder/1.0'; 'Accept'='application/json' }; $response = Invoke-WebRequest -Method Post -Uri $env:OVERPASS_URL -Body $body -ContentType 'application/x-www-form-urlencoded' -Headers $headers -TimeoutSec ([int]$env:OVERPASS_TIMEOUT); [Console]::Out.Write($response.Content)",
        ]
        completed = subprocess.run(
            command,
            capture_output=True,
            env=env,
            timeout=timeout_seconds + 15,
            check=False,
        )
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="replace").strip()
            stdout = completed.stdout.decode("utf-8", errors="replace").strip()
            raise RuntimeError(stderr or stdout or "PowerShell Overpass request failed")
        return json.loads(completed.stdout.decode("utf-8", errors="replace"))

    def fetch_with_urllib(url: str) -> dict:
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
        return json.loads(body)

    for attempt in range(OVERPASS_RETRY_PASSES):
        for url in ENDPOINT_CANDIDATES:
            try:
                data = fetch_with_urllib(url)
                accepted = accept_response(data, url)
                if accepted:
                    return accepted
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
                last_transport_error = error
            if POWERSHELL_COMMAND:
                try:
                    data = fetch_with_powershell(url)
                    accepted = accept_response(data, url)
                    if accepted:
                        return accepted
                except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
                    last_transport_error = error

        if attempt + 1 < OVERPASS_RETRY_PASSES:
            time.sleep(OVERPASS_RETRY_DELAY_SECONDS * (attempt + 1))

    if saw_empty_response and not last_transport_error:
        raise RuntimeError("Réponse Overpass vide")
    raise RuntimeError(str(last_transport_error or ("Réponse Overpass vide" if saw_empty_response else "Aucune réponse Overpass")))


def point_to_xy(point: list[float], reference_lat: float) -> tuple[float, float]:
    lat, lon = point
    x = lon * 111320.0 * math.cos(math.radians(reference_lat))
    y = lat * 110540.0
    return x, y


def nearest_route_position(point: list[float], segments: list[list[list[float]]]) -> tuple[float, float]:
    best_distance = math.inf
    best_position = 0.0
    cumulative = 0.0

    for segment in segments:
        for index in range(1, len(segment)):
            start = segment[index - 1]
            end = segment[index]
            segment_length = haversine(start, end)
            if segment_length <= 0:
                continue

            reference_lat = (point[0] + start[0] + end[0]) / 3
            px, py = point_to_xy(point, reference_lat)
            ax, ay = point_to_xy(start, reference_lat)
            bx, by = point_to_xy(end, reference_lat)
            dx = bx - ax
            dy = by - ay
            length_sq = dx * dx + dy * dy
            if length_sq <= 0:
                cumulative += segment_length
                continue

            ratio = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
            proj_x = ax + ratio * dx
            proj_y = ay + ratio * dy
            distance = math.hypot(px - proj_x, py - proj_y)

            if distance < best_distance:
                best_distance = distance
                best_position = cumulative + segment_length * ratio

            cumulative += segment_length

    return best_distance, best_position


def normalize_place_name(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).casefold()


def extract_route_cities(
    segments: list[list[list[float]]], place_data: dict, metadata: dict | None = None
) -> list[dict]:
    entries: list[dict] = []

    for element in place_data.get("elements", []):
        if element.get("type") != "node":
            continue

        tags = element.get("tags", {})
        name = str(tags.get("name") or "").strip()
        place_type = str(tags.get("place") or "").strip().lower()
        lat = element.get("lat")
        lon = element.get("lon")
        if not name or not PLACE_TYPES_RE.match(place_type):
            continue
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue

        point = [float(lat), float(lon)]
        if should_clip_to_metro_france(metadata) and not is_in_metro_france(point):
            continue

        distance_to_route, position_on_route = nearest_route_position(point, segments)
        max_distance = PLACE_DISTANCE_LIMITS.get(place_type, PLACE_SEARCH_RADIUS_METERS)
        if math.isinf(distance_to_route) or distance_to_route > max_distance:
            continue

        population_text = str(tags.get("population") or "")
        population = int(re.sub(r"\D", "", population_text) or 0)
        entries.append(
            {
                "name": name,
                "place": place_type,
                "km": round(position_on_route / 1000, 1),
                "population": population,
                "distanceToRouteM": round(distance_to_route),
            }
        )

    entries.sort(
        key=lambda item: (
            item["km"],
            PLACE_PRIORITY.get(item["place"], 99),
            item["distanceToRouteM"],
            -item["population"],
            normalize_place_name(item["name"]),
        )
    )

    deduped: list[dict] = []
    for entry in entries:
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(deduped)
                if normalize_place_name(existing["name"]) == normalize_place_name(entry["name"])
                and abs(existing["km"] - entry["km"]) < 5
            ),
            None,
        )
        if duplicate_index is None:
            deduped.append(entry)
            continue

        existing = deduped[duplicate_index]
        existing_rank = (
            PLACE_PRIORITY.get(existing["place"], 99),
            existing["distanceToRouteM"],
            -existing["population"],
        )
        candidate_rank = (
            PLACE_PRIORITY.get(entry["place"], 99),
            entry["distanceToRouteM"],
            -entry["population"],
        )
        if candidate_rank < existing_rank:
            deduped[duplicate_index] = entry

    deduped.sort(key=lambda item: (item["km"], PLACE_PRIORITY.get(item["place"], 99), item["name"]))
    return [
        {"name": item["name"], "place": item["place"], "km": item["km"]}
        for item in deduped
    ]


def resolve_route_cities(route_ref: str, display_name: str, metadata: dict, segments: list[list[list[float]]]) -> list[dict]:
    last_error: Exception | None = None
    collected_elements: list[dict] = []
    has_gpx_source = bool(str(metadata.get("gpxUrl") or "").strip()) or bool(
        normalize_gpx_source_list(metadata.get("orderedGpxSources"))
    )
    should_accumulate_queries = any(
        normalize_relation_id_list(metadata.get(key))
        for key in ["orderedRelationIds", "placeRelationIds"]
    )
    can_query_by_route = bool(metadata.get("relationId")) or any(
        normalize_relation_id_list(metadata.get(key))
        for key in ["relationIds", "orderedRelationIds", "placeRelationIds"]
    )
    explicit_query_count = int(bool(metadata.get("relationId")))
    explicit_query_count += sum(
        1
        for key in ["relationIds", "orderedRelationIds", "placeRelationIds"]
        if normalize_relation_id_list(metadata.get(key))
    )

    if not (has_gpx_source and not can_query_by_route):
        for query_index, query_text in enumerate(build_place_queries(route_ref, display_name, metadata)):
            try:
                data, _source_url = fetch_overpass(
                    query_text,
                    timeout_seconds=OVERPASS_PLACE_FETCH_TIMEOUT_SECONDS,
                    require_elements=True,
                )
                elements = data.get("elements") or []
                if not elements:
                    continue
                if should_accumulate_queries and query_index < explicit_query_count:
                    collected_elements.extend(elements)
                    cities = extract_route_cities(segments, {"elements": collected_elements}, metadata)
                    if cities:
                        return cities
                    continue

                cities = extract_route_cities(segments, {"elements": elements}, metadata)
                if cities:
                    return cities

                collected_elements.extend(elements)
            except Exception as error:  # noqa: BLE001
                last_error = error

    if collected_elements:
        cities = extract_route_cities(segments, {"elements": collected_elements}, metadata)
        if cities:
            return cities

    try:
        data, _source_url = fetch_overpass(
            build_sampled_place_query(segments),
            timeout_seconds=OVERPASS_PLACE_FETCH_TIMEOUT_SECONDS,
            require_elements=True,
        )
        cities = extract_route_cities(segments, data, metadata)
        if cities:
            return cities
    except Exception as error:  # noqa: BLE001
        last_error = error

    if last_error:
        raise RuntimeError(str(last_error))
    return []


def compute_total_distance(segments: list[list[list[float]]]) -> float:
    total = 0.0
    for latlngs in segments:
        for index in range(1, len(latlngs)):
            total += haversine(latlngs[index - 1], latlngs[index])
    return total


def build_point_offsets(segment: list[list[float]]) -> list[float]:
    offsets = [0.0]
    for index in range(1, len(segment)):
        offsets.append(offsets[index - 1] + haversine(segment[index - 1], segment[index]))
    return offsets


def round_segments(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    return [
        [[round(point[0], 5), round(point[1], 5)] for point in segment]
        for segment in segments
    ]


def simplify_segment(segment: list[list[float]]) -> list[list[float]]:
    if len(segment) <= 80:
        return segment
    if len(segment) > 1200:
        step = 6
    elif len(segment) > 700:
        step = 5
    elif len(segment) > 320:
        step = 4
    elif len(segment) > 180:
        step = 3
    else:
        step = 2
    simplified = [segment[0]]
    simplified.extend(segment[index] for index in range(step, len(segment) - 1, step))
    simplified.append(segment[-1])
    return simplified


def prepare_segments_for_cache(segments: list[list[list[float]]]) -> tuple[list[list[list[float]]], list[list[float]]]:
    cached_segments: list[list[list[float]]] = []
    cached_point_meters: list[list[float]] = []

    for segment in segments:
        point_offsets = build_point_offsets(segment)
        simplified = simplify_segment(segment)
        rounded_segment = [[round(point[0], 5), round(point[1], 5)] for point in simplified]

        original_indexes: list[int] = []
        scan_index = 0
        for point in simplified:
            while scan_index < len(segment):
                if segment[scan_index] == point:
                    original_indexes.append(scan_index)
                    scan_index += 1
                    break
                scan_index += 1
            else:
                raise RuntimeError("Impossible de retrouver un point simplifié dans le segment source")

        cached_segments.append(rounded_segment)
        cached_point_meters.append([round(point_offsets[index], 1) for index in original_indexes])

    return cached_segments, cached_point_meters


def resolve_route(route: dict, metadata: dict) -> tuple[dict, dict]:
    route_ref = normalize_ref(route.get("ref"))
    display_name = metadata.get("displayName") or route.get("nom") or route_ref
    last_error: Exception | None = None
    ordered_gpx_sources = normalize_gpx_source_list(metadata.get("orderedGpxSources"))
    gpx_url = str(metadata.get("gpxUrl") or "").strip()
    ordered_relation_ids = normalize_relation_id_list(metadata.get("orderedRelationIds"))

    if ordered_gpx_sources:
        try:
            segment_groups: list[list[list[list[float]]]] = []
            raw_segment_count = 0
            source_urls: list[str] = []

            for gpx_source in ordered_gpx_sources:
                extracted, source_url = extract_segments_from_gpx_source(gpx_source, metadata)
                if not extracted["ordered_segments"]:
                    raise RuntimeError(f"Aucun tracé trouvé dans la source GPX {source_url} de {route_ref}")

                if extracted["chain_count"] == 1:
                    segment_groups.append([collapse_ordered_segment_group(extracted["ordered_segments"])])
                else:
                    segment_groups.append(extracted["ordered_segments"])
                raw_segment_count += int(extracted.get("raw_segment_count") or len(extracted["ordered_segments"]))
                source_urls.append(source_url)

            extracted = compose_ordered_segments(segment_groups)
            extracted["raw_segment_count"] = raw_segment_count
            if extracted["ordered_segments"]:
                unique_sources = list(OrderedDict.fromkeys(source_urls))
                return extracted, {"source": ", ".join(unique_sources)}
        except Exception as error:  # noqa: BLE001
            last_error = error

    if gpx_url:
        try:
            extracted, source_url = extract_segments_from_gpx_source({"url": gpx_url}, metadata)
            if extracted["ordered_segments"]:
                return extracted, {"source": source_url}
        except Exception as error:  # noqa: BLE001
            last_error = error

    if ordered_relation_ids:
        try:
            segment_groups: list[list[list[list[float]]]] = []
            raw_segment_count = 0
            source_urls: list[str] = []

            for relation_id in ordered_relation_ids:
                data, source_url = fetch_overpass(
                    build_relation_geometry_query([relation_id]),
                    timeout_seconds=OVERPASS_ROUTE_FETCH_TIMEOUT_SECONDS,
                    require_elements=True,
                )
                extracted = extract_segments(data, display_name, metadata)
                if not extracted["ordered_segments"]:
                    raise RuntimeError(f"Aucun tracé trouvé pour la relation {relation_id} de {route_ref}")

                if extracted["chain_count"] == 1:
                    segment_groups.append([collapse_ordered_segment_group(extracted["ordered_segments"])])
                else:
                    segment_groups.append(extracted["ordered_segments"])
                raw_segment_count += extracted["raw_segment_count"]
                source_urls.append(source_url)

            extracted = compose_ordered_segments(segment_groups)
            extracted["raw_segment_count"] = raw_segment_count
            if extracted["ordered_segments"]:
                unique_sources = list(OrderedDict.fromkeys(source_urls))
                return extracted, {"source": ", ".join(unique_sources)}
        except Exception as error:  # noqa: BLE001
            last_error = error

    for query_text in build_queries(route_ref, display_name, metadata):
        try:
            data, source_url = fetch_overpass(
                query_text,
                timeout_seconds=OVERPASS_ROUTE_FETCH_TIMEOUT_SECONDS,
                require_elements=True,
            )
            extracted = extract_segments(data, display_name, metadata)
            if extracted["ordered_segments"]:
                return extracted, {"source": source_url}
        except Exception as error:  # noqa: BLE001
            last_error = error

    raise RuntimeError(str(last_error or f"Aucun tracé trouvé pour {route_ref}"))


def fetch_region_geojson() -> dict:
    request = urllib.request.Request(REGION_GEOJSON_URL, headers={"User-Agent": "gr-cache-builder/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def geometry_bbox(geometry: dict) -> tuple[float, float, float, float]:
    points: list[tuple[float, float]] = []

    def collect(coords: Iterable) -> None:
        for item in coords:
            if isinstance(item, list) and item and isinstance(item[0], (int, float)):
                points.append((float(item[0]), float(item[1])))
            else:
                collect(item)

    collect(geometry["coordinates"])
    lons = [point[0] for point in points]
    lats = [point[1] for point in points]
    return min(lons), min(lats), max(lons), max(lats)


def point_on_segment(lon: float, lat: float, a: list[float], b: list[float], epsilon: float = 1e-9) -> bool:
    ax, ay = a
    bx, by = b
    cross = (lon - ax) * (by - ay) - (lat - ay) * (bx - ax)
    if abs(cross) > epsilon:
        return False
    dot = (lon - ax) * (bx - ax) + (lat - ay) * (by - ay)
    if dot < -epsilon:
        return False
    squared_length = (bx - ax) ** 2 + (by - ay) ** 2
    if dot - squared_length > epsilon:
        return False
    return True


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    for index in range(len(ring)):
        start = ring[index]
        end = ring[(index + 1) % len(ring)]
        if point_on_segment(lon, lat, start, end):
            return True
        x1, y1 = start
        x2, y2 = end
        intersects = ((y1 > lat) != (y2 > lat)) and (
            lon < (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-12) + x1
        )
        if intersects:
            inside = not inside
    return inside


def point_in_polygon(lon: float, lat: float, polygon: list[list[list[float]]]) -> bool:
    if not polygon:
        return False
    if not point_in_ring(lon, lat, polygon[0]):
        return False
    for hole in polygon[1:]:
        if point_in_ring(lon, lat, hole):
            return False
    return True


def point_in_geometry(lon: float, lat: float, geometry: dict) -> bool:
    geometry_type = geometry["type"]
    coordinates = geometry["coordinates"]
    if geometry_type == "Polygon":
        return point_in_polygon(lon, lat, coordinates)
    if geometry_type == "MultiPolygon":
        return any(point_in_polygon(lon, lat, polygon) for polygon in coordinates)
    return False


def build_region_shapes(geojson: dict) -> dict[str, dict]:
    region_shapes: dict[str, dict] = {}
    for feature in geojson.get("features", []):
        name = feature.get("properties", {}).get("nom")
        meta = METRO_REGIONS.get(name)
        if not meta:
            continue
        geometry = feature.get("geometry")
        region_shapes[meta["code"]] = {
            "name": name,
            "iso": meta["iso"],
            "geometry": geometry,
            "bbox": geometry_bbox(geometry),
        }
    return region_shapes


def parse_svg_path_polygons(path_data: str) -> list[list[list[float]]]:
    tokens = SVG_PATH_TOKEN_RE.findall(path_data)
    polygons: list[list[list[float]]] = []
    current: list[list[float]] = []
    index = 0

    while index < len(tokens):
        token = tokens[index]
        if token == "M":
            if current:
                polygons.append(current)
                current = []
            current.append([float(tokens[index + 1]), float(tokens[index + 2])])
            index += 3
            continue
        if token == "L":
            current.append([float(tokens[index + 1]), float(tokens[index + 2])])
            index += 3
            continue
        if token == "Z":
            if current:
                polygons.append(current)
                current = []
            index += 1
            continue
        index += 1

    if current:
        polygons.append(current)

    return [polygon for polygon in polygons if len(polygon) >= 3]


def build_local_region_shapes() -> dict[str, dict]:
    if not LOCAL_REGION_DEFS_PATH.exists():
        return {}

    try:
        raw_text = LOCAL_REGION_DEFS_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}

    region_shapes: dict[str, dict] = {}
    for code, path_data in REGION_DEF_RE.findall(raw_text):
        meta = METRO_REGIONS_BY_CODE.get(code)
        if not meta:
            continue

        polygons = parse_svg_path_polygons(path_data)
        if not polygons:
            continue

        geometry = (
            {"type": "Polygon", "coordinates": [polygons[0]]}
            if len(polygons) == 1
            else {"type": "MultiPolygon", "coordinates": [[polygon] for polygon in polygons]}
        )
        region_shapes[code] = {
            "name": meta["name"],
            "iso": meta["iso"],
            "geometry": geometry,
            "bbox": geometry_bbox(geometry),
            "space": "svg",
        }

    return region_shapes


def project_point_to_local_region_map(lon: float, lat: float) -> tuple[float, float]:
    x = LOCAL_REGION_MAP_BOUNDS["min_x"] + (lon - LOCAL_REGION_MAP_BOUNDS["min_lon"]) * (
        LOCAL_REGION_MAP_BOUNDS["max_x"] - LOCAL_REGION_MAP_BOUNDS["min_x"]
    ) / (LOCAL_REGION_MAP_BOUNDS["max_lon"] - LOCAL_REGION_MAP_BOUNDS["min_lon"])
    y = LOCAL_REGION_MAP_BOUNDS["min_y"] + (LOCAL_REGION_MAP_BOUNDS["max_lat"] - lat) * (
        LOCAL_REGION_MAP_BOUNDS["max_y"] - LOCAL_REGION_MAP_BOUNDS["min_y"]
    ) / (LOCAL_REGION_MAP_BOUNDS["max_lat"] - LOCAL_REGION_MAP_BOUNDS["min_lat"])
    return x, y


def project_bbox_to_local_region_map(bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    min_x, min_y = project_point_to_local_region_map(bounds[0], bounds[3])
    max_x, max_y = project_point_to_local_region_map(bounds[2], bounds[1])
    return min(min_x, max_x), min(min_y, max_y), max(min_x, max_x), max(min_y, max_y)


def load_region_shapes() -> dict[str, dict]:
    local_region_shapes = build_local_region_shapes()
    if local_region_shapes:
        return local_region_shapes

    try:
        return build_region_shapes(fetch_region_geojson())
    except Exception as error:  # noqa: BLE001
        raise


def write_cache_indexes(
    manifest_routes: dict[str, dict],
    unresolved: dict[str, str],
    region_membership: dict[str, list[str]],
) -> None:
    route_manifest = {
        "generatedAt": BUILD_GENERATED_AT,
        "count": len(manifest_routes),
        "routes": dict(sorted(manifest_routes.items(), key=lambda item: sort_ref_key(item[0]))),
        "unresolved": dict(sorted(unresolved.items(), key=lambda item: sort_ref_key(item[0]))),
    }
    ROUTE_MANIFEST_PATH.write_text(
        "window.GR_ROUTE_CACHE_MANIFEST = " + json.dumps(route_manifest, ensure_ascii=False, separators=(",", ":")) + ";",
        encoding="utf-8",
    )

    region_payload = {
        "generatedAt": BUILD_GENERATED_AT,
        "regions": {
            code: sorted(set(refs), key=sort_ref_key)
            for code, refs in sorted(region_membership.items())
        },
        "unresolved": dict(sorted(unresolved.items(), key=lambda item: sort_ref_key(item[0]))),
    }
    REGION_CACHE_PATH.write_text(
        "window.GR_REGION_CACHE = " + json.dumps(region_payload, ensure_ascii=False, separators=(",", ":")) + ";",
        encoding="utf-8",
    )


def read_existing_route_cache(route_ref: str) -> dict | None:
    cache_path = ROUTE_CACHE_DIR / f"{route_ref}.json"
    if not cache_path.exists():
        return None

    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict) or not payload.get("segments"):
        return None
    return payload


def read_existing_index(js_path: Path, prefix: str) -> dict | None:
    if not js_path.exists():
        return None

    try:
        raw_text = js_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None

    if not raw_text.startswith(prefix):
        return None

    payload_text = raw_text[len(prefix):].rstrip(";\n\r\t ")
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None

    return payload if isinstance(payload, dict) else None


def route_bbox(segments: list[list[list[float]]]) -> tuple[float, float, float, float]:
    lats = [point[0] for segment in segments for point in segment]
    lons = [point[1] for segment in segments for point in segment]
    return min(lons), min(lats), max(lons), max(lats)


def bboxes_intersect(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> bool:
    return not (left[2] < right[0] or left[0] > right[2] or left[3] < right[1] or left[1] > right[3])


def route_intersects_region(segments: list[list[list[float]]], route_bounds: tuple[float, float, float, float], region: dict) -> bool:
    if region.get("space") == "svg":
        if not bboxes_intersect(project_bbox_to_local_region_map(route_bounds), region["bbox"]):
            return False

        for segment in segments:
            for point in segment:
                x, y = project_point_to_local_region_map(point[1], point[0])
                if point_in_geometry(x, y, region["geometry"]):
                    return True
        return False

    if not bboxes_intersect(route_bounds, region["bbox"]):
        return False

    for segment in segments:
        for point in segment:
            lon = point[1]
            lat = point[0]
            if point_in_geometry(lon, lat, region["geometry"]):
                return True
    return False


def build_manifest_entry(payload: dict, display_name: str, summary: str) -> dict:
    return {
        "file": f"route-cache/{normalize_ref(payload.get('ref'))}.json",
        "displayName": payload.get("displayName") or display_name,
        "summary": payload.get("summary") or summary,
        "totalKm": payload.get("totalKm"),
        "rawSegmentCount": payload.get("rawSegmentCount", len(payload.get("segments", []))),
        "chainCount": payload.get("chainCount", len(payload.get("segments", []))),
    }


def index_local_route_caches(
    metadata_map: dict[str, dict],
    region_shapes: dict[str, dict],
    *,
    skip_refs: set[str] | None = None,
) -> tuple[dict[str, dict], dict[str, list[str]]]:
    skip_refs = skip_refs or set()
    manifest_routes: dict[str, dict] = {}
    region_membership: dict[str, list[str]] = {code: [] for code in region_shapes}

    for cache_path in sorted(ROUTE_CACHE_DIR.glob("*.json"), key=lambda path: sort_ref_key(path.stem)):
        route_ref = normalize_ref(cache_path.stem)
        if route_ref in skip_refs:
            continue

        payload = read_existing_route_cache(route_ref)
        if not payload:
            continue

        metadata = metadata_map.get(route_ref, {})
        display_name = metadata.get("displayName") or payload.get("displayName") or route_ref
        summary = metadata.get("summary") or payload.get("summary") or ""
        manifest_routes[route_ref] = build_manifest_entry(payload, display_name, summary)

        bounds = route_bbox(payload["segments"])
        for region_code, region in region_shapes.items():
            if route_intersects_region(payload["segments"], bounds, region):
                region_membership[region_code].append(route_ref)

    return manifest_routes, region_membership


def main() -> int:
    routes = json.loads(ROUTES_PATH.read_text(encoding="utf-8"))
    metadata_map = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    ROUTE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    skip_cities = "--skip-cities" in sys.argv[1:]
    raw_args = [value for value in sys.argv[1:] if value not in {"--reindex-only", "--skip-cities"}]
    reindex_only = "--reindex-only" in sys.argv[1:]
    only_refs = {normalize_ref(value) for value in raw_args}
    existing_manifest = read_existing_index(ROUTE_MANIFEST_PATH, "window.GR_ROUTE_CACHE_MANIFEST = ") or {}
    existing_region_cache = read_existing_index(REGION_CACHE_PATH, "window.GR_REGION_CACHE = ") or {}
    existing_unresolved = existing_manifest.get("unresolved") or {}

    if reindex_only:
        local_region_shapes = build_local_region_shapes()
        if local_region_shapes:
            manifest_routes, region_membership = index_local_route_caches(metadata_map, local_region_shapes)
        else:
            manifest_routes = {}
            for cache_path in sorted(ROUTE_CACHE_DIR.glob("*.json"), key=lambda path: sort_ref_key(path.stem)):
                route_ref = normalize_ref(cache_path.stem)
                payload = read_existing_route_cache(route_ref)
                if not payload:
                    continue

                metadata = metadata_map.get(route_ref, {})
                display_name = metadata.get("displayName") or payload.get("displayName") or route_ref
                summary = metadata.get("summary") or payload.get("summary") or ""
                manifest_routes[route_ref] = build_manifest_entry(payload, display_name, summary)

            region_membership = {
                code: [
                    normalize_ref(route_ref)
                    for route_ref in refs
                    if normalize_ref(route_ref) in manifest_routes
                ]
                for code, refs in (existing_region_cache.get("regions") or {}).items()
            }
        unresolved = {
            normalize_ref(route_ref): str(error_text)
            for route_ref, error_text in existing_unresolved.items()
            if normalize_ref(route_ref) not in manifest_routes and str(error_text) == "Réponse Overpass vide"
        }
        write_cache_indexes(manifest_routes, unresolved, region_membership)
        print(json.dumps({"cachedRoutes": len(manifest_routes), "unresolved": len(unresolved)}, ensure_ascii=False))
        return 0 if manifest_routes else 1

    if only_refs:
        routes = [route for route in routes if normalize_ref(route.get("ref")) in only_refs]

    region_shapes = load_region_shapes()
    tracked_refs = {
        normalize_ref(route_ref)
        for route_ref in [*(existing_manifest.get("routes") or {}).keys(), *existing_unresolved.keys()]
    }
    manifest_routes, region_membership = index_local_route_caches(metadata_map, region_shapes)
    unresolved: dict[str, str] = {}
    pending_routes: list[dict] = []

    for route_ref, error_text in existing_unresolved.items():
        normalized_ref = normalize_ref(route_ref)
        if normalized_ref in only_refs or normalized_ref in manifest_routes:
            continue
        if only_refs or str(error_text) == "Réponse Overpass vide":
            unresolved[normalized_ref] = str(error_text)

    for route in routes:
        route_ref = normalize_ref(route.get("ref"))
        metadata = metadata_map.get(route_ref, {})
        display_name = metadata.get("displayName") or route.get("nom") or route_ref
        summary = metadata.get("summary") or route.get("description") or ""
        existing_payload = None if route_ref in only_refs else read_existing_route_cache(route_ref)
        if not existing_payload:
            pending_routes.append(route)
            continue

        unresolved.pop(route_ref, None)

        if (
            not isinstance(existing_payload.get("cities"), list)
            or not isinstance(existing_payload.get("segmentPointMeters"), list)
            or existing_payload.get("citiesSkipped") is True
        ):
            pending_routes.append(route)

    write_cache_indexes(manifest_routes, unresolved, region_membership)

    for index, route in enumerate(pending_routes, start=1):
        route_ref = normalize_ref(route.get("ref"))
        metadata = metadata_map.get(route_ref, {})
        display_name = metadata.get("displayName") or route.get("nom") or route_ref
        summary = metadata.get("summary") or route.get("description") or ""
        print(f"[{index}/{len(pending_routes)}] {route_ref} ...", flush=True)

        try:
            print("    fetching route geometry...", flush=True)
            extracted, fetch_meta = resolve_route(route, metadata)
            ordered_segments = extracted["ordered_segments"]
            print(
                f"    route geometry ok: {extracted['chain_count']} chain(s), {extracted['raw_segment_count']} raw segment(s), source {fetch_meta['source']}",
                flush=True,
            )
            cached_segments, cached_point_meters = prepare_segments_for_cache(ordered_segments)
            total_distance_km = round(compute_total_distance(ordered_segments) / 1000, 1)
            cities: list[dict] = []
            cities_skipped = skip_cities
            if skip_cities:
                print("    city lookup skipped by flag", flush=True)
            else:
                try:
                    print("    fetching nearby cities...", flush=True)
                    cities = resolve_route_cities(route_ref, display_name, metadata, ordered_segments)
                    print(f"    cities ok: {len(cities)} retained", flush=True)
                except Exception as city_error:  # noqa: BLE001
                    cities_skipped = True
                    print(f"    city lookup skipped: {city_error}", flush=True)

            payload = {
                "generatedAt": BUILD_GENERATED_AT,
                "ref": route_ref,
                "displayName": display_name,
                "summary": summary,
                "source": fetch_meta["source"],
                "rawSegmentCount": extracted["raw_segment_count"],
                "chainCount": extracted["chain_count"],
                "maxJoinGap": round(extracted["max_join_gap"], 1),
                "totalKm": total_distance_km,
                "cities": cities,
                "citiesSkipped": cities_skipped,
                "segmentPointMeters": cached_point_meters,
                "segments": cached_segments,
            }
            cache_path = ROUTE_CACHE_DIR / f"{route_ref}.json"
            print(f"    writing cache: {cache_path.name}", flush=True)
            cache_path.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
            manifest_routes[route_ref] = build_manifest_entry(payload, display_name, summary)
            unresolved.pop(route_ref, None)
            print(f"    cached: {route_ref} ({total_distance_km} km)", flush=True)

            bounds = route_bbox(ordered_segments)
            for region_code, region in region_shapes.items():
                if route_intersects_region(ordered_segments, bounds, region):
                    region_membership[region_code].append(route_ref)
        except Exception as error:  # noqa: BLE001
            if route_ref not in manifest_routes:
                unresolved[route_ref] = str(error)
            print(f"    failed: {error}", flush=True)

        write_cache_indexes(manifest_routes, unresolved, region_membership)
        time.sleep(0.15)

    print(json.dumps({"cachedRoutes": len(manifest_routes), "unresolved": len(unresolved)}, ensure_ascii=False))
    return 0 if manifest_routes else 1


if __name__ == "__main__":
    raise SystemExit(main())