#!/usr/bin/env python3
"""Compare two /api/stats dumps from a modules-OFF vs modules-ON benchmark.

Usage:
    python3 compare-benchmarks.py <OFF.json> <ON.json>

If no args, defaults to /tmp/bench-OFF-stats.json and /tmp/bench-ON-stats.json.
"""
import json
import sys
from pathlib import Path


def load(path):
    return json.loads(Path(path).read_text())


def fmt_pct(x):
    return f"{x*100:+.1f}%" if x is not None else "n/a"


def main():
    off_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bench-OFF-stats.json"
    on_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/bench-ON-stats.json"

    off = load(off_path)
    on = load(on_path)

    print(f"{'':50s} {'OFF':>12s} {'ON':>12s} {'Δ':>10s}")
    print("-" * 90)

    # Requests
    off_req = off.get("requests", 0)
    on_req = on.get("requests", 0)
    print(f"{'Total requests':50s} {off_req:>12d} {on_req:>12d} {fmt_pct((on_req-off_req)/max(off_req,1)):>10s}")

    # Per-provider calls
    r_off = off.get("router", {})
    r_on = on.get("router", {})
    for k in ("alibabaCalls", "anthropicCalls", "nvidiaCalls", "deepseekCalls",
             "openrouterCalls", "flashCalls", "fallbacks"):
        a = r_off.get(k, 0)
        b = r_on.get(k, 0)
        if a + b > 0:
            delta = fmt_pct((b - a) / max(a, 1))
            print(f"{'  router.' + k:50s} {a:>12d} {b:>12d} {delta:>10s}")

    # Token totals per provider
    t_off = r_off.get("tokens", {})
    t_on = r_on.get("tokens", {})
    print()
    for provider in ("anthropic", "gemini", "nvidia", "deepseek", "openrouter", "local"):
        in_off = t_off.get(provider, {}).get("input", 0)
        in_on = t_on.get(provider, {}).get("input", 0)
        out_off = t_off.get(provider, {}).get("output", 0)
        out_on = t_on.get(provider, {}).get("output", 0)
        if in_off + in_on + out_off + out_on > 0:
            print(f"  {provider} in/out tokens")
            print(f"    input tokens{' '*36}{in_off:>12d} {in_on:>12d} {fmt_pct((in_on-in_off)/max(in_off,1)):>10s}")
            print(f"    output tokens{' '*35}{out_off:>12d} {out_on:>12d} {fmt_pct((out_on-out_off)/max(out_off,1)):>10s}")

    # Cost
    c_off = off.get("cost", {}).get("grandTotalUSD", 0)
    c_on = on.get("cost", {}).get("grandTotalUSD", 0)
    print()
    print(f"{'Grand total USD':50s} ${off_cost:>11.4f} ${on_cost:>11.4f} {fmt_pct((on_cost-off_cost)/max(off_cost,0.0001)):>10s}".replace("off_cost", f"{c_off:.4f}").replace("on_cost", f"{c_on:.4f}") if False else
          f"{'Grand total USD':50s} ${c_off:>11.4f} ${c_on:>11.4f}")

    # Cache ratios
    print("\n=== Cache hit ratios per model ===")
    for side, label in [(off, "OFF"), (on, "ON")]:
        cr = side.get("cacheratio", {}).get("perModel", {})
        if not cr:
            print(f"  [{label}] no cache data")
            continue
        print(f"  [{label}]")
        for model, v in cr.items():
            hit = v.get("hitRatio")
            print(f"    {model:30s} hit={fmt_pct(hit)} reads={v.get('reads',0)} writes={v.get('writes',0)} uncached={v.get('uncached',0)}")

    # Scaffolding module signals
    print("\n=== Scaffolding activity (ON session) ===")
    for mod in ("injected", "compressed", "cleaned"):
        on_v = on.get(mod, 0)
        off_v = off.get(mod, 0)
        print(f"  {mod:20s} OFF={off_v:>6d} ON={on_v:>6d}")
    cf_on = on.get("contextfilter", {})
    if "keepRecent" in cf_on:
        print(f"  contextfilter config: keepRecent={cf_on.get('keepRecent')}, shortTextLimit={cf_on.get('shortTextLimit')}")

    # Errors
    et_off = off.get("errortax", {})
    et_on = on.get("errortax", {})
    print("\n=== Errors (taxonomy) ===")
    print(f"  OFF total: {et_off.get('total', 0)}, ON total: {et_on.get('total', 0)}")
    for cls, cnt in (et_off.get("byClass", {}) or {}).items():
        print(f"    OFF  {cls:30s} {cnt}")
    for cls, cnt in (et_on.get("byClass", {}) or {}).items():
        print(f"    ON   {cls:30s} {cnt}")

    print("\n=== Summary ===")
    if c_off > 0 and c_on > 0:
        savings = (c_off - c_on) / c_off * 100
        print(f"  Cost change: {savings:+.1f}% ({'cheaper' if c_on < c_off else 'more expensive'} with modules ON)")
    if off_req > 0 and on_req > 0:
        req_change = (on_req - off_req) / off_req * 100
        print(f"  Request change: {req_change:+.1f}%")


if __name__ == "__main__":
    main()
