"""Versioned, deterministic JSON boundary for the isolated Leiden worker."""

import json
import math
import random
import sys

import igraph as ig


def cluster(data):
    if data.get("schemaVersion") != 1:
        raise ValueError("Unsupported schemaVersion")
    if not isinstance(data.get("inputVersion"), str) or not data["inputVersion"]:
        raise ValueError("inputVersion is required")
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or any(not isinstance(n, str) for n in nodes):
        raise ValueError("nodes must contain string IDs")
    if len(set(nodes)) != len(nodes):
        raise ValueError("Duplicate node IDs")
    index = {node: i for i, node in enumerate(nodes)}
    edges, weights, seen = [], [], set()
    for edge in data.get("edges", []):
        a, b, weight = edge["source"], edge["target"], edge["weight"]
        if a not in index or b not in index or a == b:
            raise ValueError("Invalid edge endpoint")
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
            raise ValueError("Edge weight must be positive and finite")
        key = tuple(sorted((a, b)))
        if key in seen:
            raise ValueError("Duplicate undirected edge")
        seen.add(key)
        edges.append((index[a], index[b]))
        weights.append(weight)
    seed = data.get("seed", 42)
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    resolution = data.get("resolution", 0.06)
    if isinstance(resolution, bool) or not isinstance(resolution, (int, float)) or not math.isfinite(resolution) or resolution <= 0:
        raise ValueError("resolution must be positive and finite")
    ig.set_random_number_generator(random.Random(seed))
    graph = ig.Graph(n=len(nodes), edges=edges, directed=False)
    if not edges:
        # Leiden has nothing to optimize in an edgeless graph. In particular,
        # don't ask an unbounded iteration loop to converge for a singleton.
        groups = [[i] for i in range(len(nodes))]
    else:
        groups = graph.community_leiden(
            objective_function="CPM",
            weights=weights if edges else None,
            resolution_parameter=resolution,
            n_iterations=10,
        )
    # Stable ordering of labels for identical input, independent of library IDs.
    members = sorted([sorted(nodes[i] for i in group) for group in groups])
    return {
        "schemaVersion": 1,
        "inputVersion": data["inputVersion"],
        "algorithm": "leiden-cpm",
        "libraryVersion": ig.__version__,
        "seed": seed,
        "resolution": resolution,
        "clusters": [{"id": f"cluster-{i}", "members": group} for i, group in enumerate(members)],
        "isolatedNodes": [nodes[i] for i, degree in enumerate(graph.degree()) if degree == 0],
    }


if __name__ == "__main__":
    try:
        raw = sys.stdin.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("Input exceeds 16 MiB")
        print(json.dumps(cluster(json.loads(raw)), ensure_ascii=False, allow_nan=False))
    except (ValueError, KeyError, TypeError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(2)
