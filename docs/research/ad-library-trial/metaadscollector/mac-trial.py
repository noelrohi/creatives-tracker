"""MetaAdsCollector trial — same pages as the ScrapeCreators run (wayfinder #150 input)."""
import dataclasses
import json
import pathlib
import sys
import traceback

from meta_ads_collector import MetaAdsCollector

OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("mac-out")
OUT.mkdir(parents=True, exist_ok=True)

PAGES = {"airwaav": "109178280892310", "shock-doctor": "92823337978"}


def to_jsonable(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: to_jsonable(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    if hasattr(obj, "__dict__"):
        return {k: to_jsonable(v) for k, v in vars(obj).items()}
    return repr(obj)


summary = {}
with MetaAdsCollector() as collector:
    for slug, page_id in PAGES.items():
        print(f"== {slug} (page_id={page_id})", flush=True)
        try:
            ads = list(
                collector.collect_by_page_id(page_id, country="US", status="ACTIVE", max_results=100)
            )
        except Exception:
            traceback.print_exc()
            summary[slug] = {"error": traceback.format_exc(limit=3)}
            continue
        dumped = [to_jsonable(ad) for ad in ads]
        (OUT / f"{slug}-ads.json").write_text(json.dumps(dumped, indent=2, default=repr))
        ids = sorted({d.get("id") or d.get("ad_archive_id") for d in dumped})
        titles = [
            (c.get("title") if isinstance(c, dict) else None)
            for d in dumped
            for c in (d.get("creatives") or [{}])[:1]
        ]
        summary[slug] = {
            "ads": len(dumped),
            "unique_ids": len(ids),
            "null_titles": sum(1 for t in titles if not t),
            "sample_keys": sorted(dumped[0].keys()) if dumped else [],
            "ids": ids,
        }
        print(f"   {len(dumped)} ads, {summary[slug]['null_titles']} null titles", flush=True)

(OUT / "summary.json").write_text(json.dumps(summary, indent=2))
print("done", flush=True)
