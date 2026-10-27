"""Exercise the actual subprocess contract, not just an imported function."""

import datetime
import json
import pathlib
import subprocess
import sys

ENTRY = pathlib.Path(__file__).with_name("cluster.py")


def run(data, expected=0):
    result = subprocess.run([sys.executable, str(ENTRY)], input=json.dumps(data), text=True, capture_output=True, timeout=30)
    assert result.returncode == expected, result.stderr
    return json.loads(result.stdout) if expected == 0 else json.loads(result.stderr)


nodes = [f"domain-{group}-{i}" for group in range(3) for i in range(10)]
edges = []
for group in range(3):
    members = nodes[group * 10:(group + 1) * 10]
    edges.extend({"source": a, "target": b, "weight": 1.0} for i, a in enumerate(members) for b in members[i + 1:])
edges.extend([
    {"source": nodes[0], "target": nodes[10], "weight": 0.01},
    {"source": nodes[10], "target": nodes[20], "weight": 0.01},
])
fixture = {"schemaVersion": 1, "inputVersion": "m0-synthetic-v1", "seed": 42, "nodes": nodes + ["isolated"], "edges": edges}
first = run(fixture)
assert first == run(fixture), "Fixed-input repeatability failed"
members = [group["members"] for group in first["clusters"]]
assert sorted(map(len, members)) == [1, 10, 10, 10], members
assert first["isolatedNodes"] == ["isolated"]
assert sum(map(len, members)) == len(fixture["nodes"])
assert run({**fixture, "nodes": [], "edges": []})["clusters"] == []
assert run({**fixture, "nodes": ["only"], "edges": []})["isolatedNodes"] == ["only"]
assert run({**fixture, "schemaVersion": 2}, 2)["error"] == "Unsupported schemaVersion"
assert run({**fixture, "edges": [{"source": "missing", "target": nodes[0], "weight": 1}]}, 2)["error"]
assert run({**fixture, "edges": [{"source": nodes[1], "target": nodes[0], "weight": -1}]}, 2)["error"]
report = {
    "status": "passed",
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "python": sys.version.split()[0],
    "checks": ["versioned-json-subprocess", "fixed-seed-repeatability", "three-dense-groups", "isolated-node", "empty-and-singleton", "invalid-input-rejected"],
    "result": first,
}
pathlib.Path("artifacts").mkdir(exist_ok=True)
pathlib.Path("artifacts/clustering.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
