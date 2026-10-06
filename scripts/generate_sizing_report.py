#!/usr/bin/env python3
"""Declared resource sizing report per RAM profile (Issue #40, static slice).

Renders both Helm charts (helm template, KUBECONFIG=/dev/null), sums the DECLARED
resources.requests/limits (cpu, memory) per workload and per namespace, and compares
the steady-state requests with the VM capacity each RAM profile declares in
scripts/common/env.sh. Flags oversubscription and workloads without requests/limits.

Declared state only: no live cluster, no measured usage, no headroom targets, no cost.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_SH = REPO_ROOT / "scripts" / "common" / "env.sh"
VAGRANTFILE = REPO_ROOT / "Vagrantfile"

_spec = importlib.util.spec_from_file_location(
    "generate_platform_asset_inventory", REPO_ROOT / "scripts" / "generate_platform_asset_inventory.py")
assert _spec and _spec.loader
_inventory = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _inventory
_spec.loader.exec_module(_inventory)
CHARTS = _inventory.CHARTS

STEADY_POD_KINDS = {"Deployment", "StatefulSet"}
TRANSIENT_POD_KINDS = {"Job", "CronJob"}
# D1: the optional services (OpenMetadata, Trino worker) are the only chart values the
# RAM profile flips (env.sh: BELUGA_PROFILE >= threshold), so two renders cover all profiles.
OPTIONAL_SET = ["--set", "openmetadata.enabled=true", "--set", "trino.workerEnabled=true"]
RENDERS = {"base": [], "optional-services": OPTIONAL_SET}

_BIN = {"Ki": 1024, "Mi": 1024**2, "Gi": 1024**3, "Ti": 1024**4, "Pi": 1024**5, "Ei": 1024**6}
_DEC = {"k": 1000, "M": 1000**2, "G": 1000**3, "T": 1000**4, "P": 1000**5, "E": 1000**6}
# Kubernetes quantity: decimal number + optional binary/decimal suffix or milli ('m'); no exponent forms.
_QUANTITY = re.compile(r"^(\d+(?:\.\d*)?|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E|m)?$")


def cpu_millicores(value) -> float:
    text = str(value)
    return float(text[:-1]) if text.endswith("m") else float(text) * 1000


def memory_mib(value, flink: bool = False) -> float:
    """Kubernetes quantity -> MiB. Flink's operator spec uses MemorySize ('1024m' = 1024 MiB).

    Unsupported forms (exponent '1e3', unknown suffix, empty) are rejected, never guessed.
    """
    text = str(value)
    match = _QUANTITY.match(text)
    if not match:
        raise ValueError(f"unsupported memory quantity {text!r} (expected number + Ki..Ei / k..E / m, or plain bytes)")
    number, suffix = float(match.group(1)), match.group(2)
    if suffix == "m":
        return number if flink else number / 1000 / 1024**2
    return number * (_BIN.get(suffix) or _DEC.get(suffix) or 1) / 1024**2


def parse_profiles(env_text: str, vagrant_text: str) -> dict:
    """Read profile VM sizing and the optional-service threshold from env.sh (single source)."""
    block = re.search(r'case "\$\{BELUGA_PROFILE\}" in(.*?)\n\s*esac', env_text, re.S)
    if not block:
        raise ValueError("env.sh: BELUGA_PROFILE case block not found")
    profiles = {}
    for label, body in re.findall(r"^\s*(\d+|\*)\)\s*\n(.*?);;", block.group(1), re.S | re.M):
        values = {k: int(v) for k, v in re.findall(r'(WORKER_MEMORY|WORKER_CPUS|MASTER_MEMORY|MASTER_CPUS)="\$\{\1:-(\d+)\}"', body)}
        if len(values) != 4:
            raise ValueError(f"env.sh: incomplete sizing for profile {label}")
        profiles["32" if label == "*" else label] = values
    threshold = re.search(r"\[\[ \$\{BELUGA_PROFILE\} -ge (\d+) \]\]", env_text[block.end():])
    if not threshold:
        raise ValueError("env.sh: optional-service profile threshold not found")
    workers = len(re.findall(r"role:\s*'worker'", vagrant_text))
    if not workers:
        raise ValueError("Vagrantfile: no worker nodes found")
    out = {}
    for name, v in profiles.items():
        out[name] = {
            "optionalServices": int(name) >= int(threshold.group(1)),
            "workerNodes": workers,
            "capacity": {
                "cpuMillicores": v["MASTER_CPUS"] * 1000 + workers * v["WORKER_CPUS"] * 1000,
                "memoryMiB": v["MASTER_MEMORY"] + workers * v["WORKER_MEMORY"],
                "workerMemoryMiB": v["WORKER_MEMORY"],
                "workerCpuMillicores": v["WORKER_CPUS"] * 1000,
            },
        }
    return out


def _res(resources: dict | None, section: str, field: str, flink: bool = False):
    raw = ((resources or {}).get(section) or {}).get(field)
    if raw is None:
        return None
    return cpu_millicores(raw) if field == "cpu" else memory_mib(raw, flink)


def _missing(resources: dict | None) -> list[str]:
    return [f"{s}.{f}" for s in ("requests", "limits") for f in ("cpu", "memory")
            if _res(resources, s, f) is None]


def _pod(spec: dict) -> dict:
    """Effective pod totals: sum(containers), requests floor = max(init) (kube scheduling rule)."""
    totals = {"requests": {"cpu": 0.0, "memory": 0.0}, "limits": {"cpu": 0.0, "memory": 0.0}}
    init_max = {"cpu": 0.0, "memory": 0.0}
    gaps = []
    limits_partial = False
    for kind, key in (("init", "initContainers"), ("main", "containers")):
        for c in spec.get(key, []):
            res = c.get("resources")
            missing = _missing(res)
            if missing:
                gaps.append(f"{c['name']} ({kind}): {' '.join(missing)}")
                if kind == "main" and any(m.startswith("limits.") for m in missing):
                    limits_partial = True
            for field in ("cpu", "memory"):
                limit = _res(res, "limits", field)
                request = _res(res, "requests", field)
                effective = request if request is not None else limit  # kube defaults requests=limits
                effective = effective or 0.0
                if kind == "init":
                    init_max[field] = max(init_max[field], effective)
                else:
                    totals["requests"][field] += effective
                    totals["limits"][field] += limit or 0.0
    for field in ("cpu", "memory"):
        totals["requests"][field] = max(totals["requests"][field], init_max[field])
    return {**totals, "gaps": sorted(gaps), "limitsPartial": limits_partial}


def _block(resources: dict | None, count: int, flink: bool = False) -> dict:
    out = {"requests": {}, "limits": {}}
    for f in ("cpu", "memory"):
        limit = _res(resources, "limits", f, flink)
        request = _res(resources, "requests", f, flink)
        out["limits"][f] = (limit or 0.0) * count
        out["requests"][f] = (request if request is not None else limit or 0.0) * count  # kube defaults requests=limits
    return out


def _find_resources(obj, path="") -> list[tuple[str, dict]]:
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "resources" and isinstance(v, dict):
                found.append((path + "/" + k, v))
            else:
                found.extend(_find_resources(v, path + "/" + k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found.extend(_find_resources(v, f"{path}[{i}]"))
    return found


def workload_record(doc: dict) -> dict | None:
    """Wrap parsing errors with the offending workload so a bad quantity is traceable."""
    try:
        return _workload_record(doc)
    except ValueError as exc:
        meta = doc.get("metadata", {})
        raise ValueError(f"{doc.get('kind')}/{meta.get('namespace', 'default')}/{meta.get('name', 'unnamed')}: {exc}") from exc


def _workload_record(doc: dict) -> dict | None:
    kind = doc.get("kind")
    meta, spec = doc.get("metadata", {}), doc.get("spec", {})
    base = {"id": f"{kind}/{meta.get('namespace', 'default')}/{meta.get('name', 'unnamed')}",
            "kind": kind, "namespace": meta.get("namespace", "default"), "name": meta.get("name", "unnamed"),
            "transient": False, "notes": []}
    if kind in STEADY_POD_KINDS | TRANSIENT_POD_KINDS:
        pod_spec = (spec.get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec", {})
                    if kind == "CronJob" else spec.get("template", {}).get("spec", {}))
        replicas = int(spec.get("replicas", 1)) if kind in STEADY_POD_KINDS else 1
        pod = _pod(pod_spec)
        base.update(replicas=replicas, transient=kind in TRANSIENT_POD_KINDS, gaps=pod["gaps"],
                    limitsPartial=pod["limitsPartial"],
                    requests={f: v * replicas for f, v in pod["requests"].items()},
                    limits={f: v * replicas for f, v in pod["limits"].items()},
                    podRequests=pod["requests"])
        return base
    if kind in ("Cluster", "KafkaNodePool"):
        count = int(spec.get("instances" if kind == "Cluster" else "replicas", 1))
        block = _block(spec.get("resources"), count)
        missing = _missing(spec.get("resources"))
        base.update(replicas=count, gaps=[f"{kind}: {' '.join(missing)}"] if missing else [],
                    limitsPartial=any(m.startswith("limits.") for m in missing),
                    podRequests={f: v / count for f, v in block["requests"].items()}, **block)
        return base
    if kind == "Kafka":
        found = _find_resources(spec)
        block = {s: {f: 0.0 for f in ("cpu", "memory")} for s in ("requests", "limits")}
        gaps = [f"{p}: {' '.join(_missing(r))}" for p, r in found if _missing(r)]
        for _, r in found:
            for f in ("cpu", "memory"):
                limit = _res(r, "limits", f)
                request = _res(r, "requests", f)
                block["limits"][f] += limit or 0.0
                block["requests"][f] += request if request is not None else limit or 0.0  # kube defaults requests=limits
        if not found:
            gaps = ["Kafka CR: no resources declared (operator-managed pods, e.g. entity operator)"]
        base.update(replicas=1, gaps=sorted(gaps), podRequests=block["requests"], **block,
                    limitsPartial=not found or any(m.startswith("limits.") for _, r in found for m in _missing(r)))
        base["notes"].append("Strimzi-managed non-broker pods are sized by the operator, not declared here")
        return base
    if kind == "FlinkDeployment":
        jm, tm = spec.get("jobManager", {}), spec.get("taskManager", {})
        total = {s: {"cpu": 0.0, "memory": 0.0} for s in ("requests", "limits")}
        gaps = []
        for label, part in (("jobManager", jm), ("taskManager", tm)):
            res = part.get("resource")
            count = int(part.get("replicas", 1))
            if not res:
                gaps.append(f"{label}: resource")
                continue
            for field in ("cpu", "memory"):
                if res.get(field) is None:
                    gaps.append(f"{label}: resource.{field}")
                    continue
                value = (cpu_millicores(res[field]) if field == "cpu" else memory_mib(res[field], flink=True)) * count
                for s in total:  # Flink operator sizes pods with request == limit by default (limit-factor 1.0)
                    total[s][field] += value
        base.update(replicas=1, gaps=sorted(gaps), podRequests=total["requests"], limitsPartial=bool(gaps), **total)
        base["notes"].append("assumes 1 JobManager + 1 TaskManager unless replicas is set (lower bound: the real TaskManager count follows the job parallelism/slots, which the chart does not declare); request == limit (operator default)")
        return base
    return None


def collect_render(docs: list[dict]) -> list[dict]:
    records = [r for r in (workload_record(d) for d in docs) if r]
    merged = {}
    for r in records:
        merged.setdefault(r["id"], r)
    return sorted(merged.values(), key=lambda r: (r["namespace"], r["kind"], r["name"]))


def _round(value: float) -> float:
    return round(value, 1) if value != int(value) else int(value)


def summarize(workloads: list[dict]) -> dict:
    namespaces: dict[str, dict] = {}
    total = {s: {"cpu": 0.0, "memory": 0.0} for s in ("requests", "limits")}
    total_partial = False
    for w in workloads:
        if w["transient"]:
            continue
        ns = namespaces.setdefault(w["namespace"], {"workloads": 0, "limitsPartial": False, **{s: {"cpu": 0.0, "memory": 0.0} for s in total}})
        ns["workloads"] += 1
        ns["limitsPartial"] = ns["limitsPartial"] or w["limitsPartial"]
        total_partial = total_partial or w["limitsPartial"]
        for s in total:
            for f in ("cpu", "memory"):
                ns[s][f] += w[s][f]
                total[s][f] += w[s][f]
    clean = lambda d: {s: {f: _round(v) for f, v in d[s].items()} for s in ("requests", "limits")}  # noqa: E731
    return {"namespaces": {n: {"workloads": v["workloads"], "limitsPartial": v["limitsPartial"], **clean(v)}
                           for n, v in sorted(namespaces.items())},
            "total": {**clean(total), "limitsPartial": total_partial}}


def evaluate(profile: dict, summary: dict, workloads: list[dict]) -> dict:
    cap = profile["capacity"]
    req = summary["total"]["requests"]
    lim = summary["total"]["limits"]
    violations = []
    if req["cpu"] > cap["cpuMillicores"]:
        violations.append(f"requests.cpu {_round(req['cpu'])}m > capacity {cap['cpuMillicores']}m")
    if req["memory"] > cap["memoryMiB"]:
        violations.append(f"requests.memory {_round(req['memory'])}MiB > capacity {cap['memoryMiB']}MiB")
    for w in workloads:
        if w["transient"]:
            continue
        pod = w["podRequests"]
        if pod["memory"] > cap["workerMemoryMiB"] or pod["cpu"] > cap["workerCpuMillicores"]:
            violations.append(f"{w['id']} per-pod requests exceed one worker VM")
    return {
        "requestsPctOfCapacity": {"cpu": round(100 * req["cpu"] / cap["cpuMillicores"], 1),
                                  "memory": round(100 * req["memory"] / cap["memoryMiB"], 1)},
        # None (rendered n/a) when any summed workload declares no limit: a partial sum would understate
        "limitsPctOfCapacity": None if summary["total"]["limitsPartial"] else {
            "cpu": round(100 * lim["cpu"] / cap["cpuMillicores"], 1),
            "memory": round(100 * lim["memory"] / cap["memoryMiB"], 1)},
        "oversubscribed": bool(violations), "violations": violations,
    }


def public(w: dict) -> dict:
    out = {k: w[k] for k in ("id", "kind", "namespace", "replicas", "transient", "gaps", "notes", "limitsPartial")}
    for s in ("requests", "limits"):
        out[s] = {f: _round(v) for f, v in w[s].items()}
    return out


def build_report(rendered: dict[str, list[dict]], profiles: dict) -> dict:
    renders = {}
    for name, docs in rendered.items():
        workloads = collect_render(docs)
        renders[name] = {"workloads": [public(w) for w in workloads],
                         "_raw": workloads, **summarize(workloads)}
    profile_out = {}
    for name, p in sorted(profiles.items(), key=lambda kv: int(kv[0])):
        render = "optional-services" if p["optionalServices"] else "base"
        ev = evaluate(p, renders[render], renders[render]["_raw"])
        profile_out[name] = {"render": render, "capacity": p["capacity"], "workerNodes": p["workerNodes"], **ev}
    for r in renders.values():
        r.pop("_raw")
    return {"scope": "declared-state static report; no live cluster, no measured usage",
            "units": {"cpu": "millicores", "memory": "MiB"}, "charts": list(CHARTS),
            "renders": renders, "profiles": profile_out}


def render_markdown(report: dict) -> str:
    L = ["# Declared Resource Sizing Report", "",
         f"> {report['scope']}. CPU in millicores, memory in MiB. See docs/development.md for what this does NOT report.", "",
         "## Profiles vs declared VM capacity", "",
         "| Profile (GB) | Render | Capacity cpu / mem | Requests cpu / mem | Requests % cpu / mem | Limits % cpu / mem | Status |",
         "|---|---|---|---|---|---|---|"]
    for name, p in report["profiles"].items():
        total = report["renders"][p["render"]]["total"]
        cap = p["capacity"]
        lp = p["limitsPctOfCapacity"]
        limits_pct = "n/a*" if lp is None else f"{lp['cpu']} / {lp['memory']}"
        L.append(f"| {name} | {p['render']} | {cap['cpuMillicores']} / {cap['memoryMiB']} | "
                 f"{total['requests']['cpu']} / {total['requests']['memory']} | "
                 f"{p['requestsPctOfCapacity']['cpu']} / {p['requestsPctOfCapacity']['memory']} | "
                 f"{limits_pct} | "
                 f"{'OVERSUBSCRIBED' if p['oversubscribed'] else 'ok'} |")
    if any(p["limitsPctOfCapacity"] is None for p in report["profiles"].values()):
        L += ["", "\\* n/a: at least one summed workload declares no limit (see Gaps), so a limits percentage would understate."]
    for name, p in report["profiles"].items():
        for v in p["violations"]:
            L.append(f"\n- profile {name}: {v}")
    for rname, r in report["renders"].items():
        L += ["", f"## Render `{rname}`", "", "### Namespaces (steady-state workloads; limits '(partial)' = sums only the declared limits)", "",
              "| Namespace | Workloads | Requests cpu / mem | Limits cpu / mem |", "|---|---|---|---|"]
        for ns, v in r["namespaces"].items():
            L.append(f"| {ns} | {v['workloads']} | {v['requests']['cpu']} / {v['requests']['memory']} | "
                     f"{v['limits']['cpu']} / {v['limits']['memory']}{' (partial)' if v['limitsPartial'] else ''} |")
        t = r["total"]
        L.append(f"| **total** | {sum(v['workloads'] for v in r['namespaces'].values())} | "
                 f"{t['requests']['cpu']} / {t['requests']['memory']} | {t['limits']['cpu']} / {t['limits']['memory']}{' (partial)' if t['limitsPartial'] else ''} |")
        for title, transient in (("Steady-state workloads", False), ("Transient Jobs/CronJobs (not summed)", True)):
            L += ["", f"### {title}", "", "| Workload | Replicas | Requests cpu / mem | Limits cpu / mem | Gaps |", "|---|---|---|---|---|"]
            for w in r["workloads"]:
                if w["transient"] == transient:
                    gaps = "; ".join(w["gaps"]) or "-"
                    L.append(f"| {w['id']} | {w['replicas']} | {w['requests']['cpu']} / {w['requests']['memory']} | "
                             f"{w['limits']['cpu']} / {w['limits']['memory']} | {gaps} |")
        notes = sorted({f"{w['id']}: {n}" for w in r["workloads"] for n in w["notes"]})
        L += ["", "### Notes", ""] + [f"- {n}" for n in notes] if notes else []
    return "\n".join(L) + "\n"


def render_all(env_file: Path = ENV_SH) -> tuple[dict[str, list[dict]], dict]:
    profiles = parse_profiles(env_file.read_text(encoding="utf-8"), VAGRANTFILE.read_text(encoding="utf-8"))
    rendered = {name: [d for chart in CHARTS for d in _inventory.render_chart(chart, args)]
                for name, args in RENDERS.items()}
    return rendered, profiles


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if any profile's declared requests exceed its capacity")
    parser.add_argument("--json", action="store_true", help="print JSON instead of Markdown")
    parser.add_argument("--out", type=Path, help="write sizing-report.md and sizing-report.json into this directory")
    parser.add_argument("--env-file", type=Path, default=ENV_SH, help="env.sh to read profile capacity from")
    args = parser.parse_args()

    rendered, profiles = render_all(args.env_file)
    report = build_report(rendered, profiles)
    md = render_markdown(report)
    js = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "sizing-report.md").write_text(md, encoding="utf-8")
        (args.out / "sizing-report.json").write_text(js, encoding="utf-8")
    if args.check:
        bad = {n: p for n, p in report["profiles"].items() if p["oversubscribed"]}
        for n, p in report["profiles"].items():
            print(f"profile {n}: requests {p['requestsPctOfCapacity']['cpu']}% cpu / "
                  f"{p['requestsPctOfCapacity']['memory']}% mem of declared VM capacity "
                  f"({'OVERSUBSCRIBED' if p['oversubscribed'] else 'ok'})")
        for n, p in bad.items():
            for v in p["violations"]:
                print(f"FAIL profile {n}: {v}", file=sys.stderr)
        return 1 if bad else 0
    if not args.out:
        print(js if args.json else md, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
