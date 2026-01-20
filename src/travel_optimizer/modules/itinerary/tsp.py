"""TSP helpers for itinerary ordering."""

from __future__ import annotations

from itertools import permutations
from typing import Dict, List, Tuple


def solve_tsp_bruteforce(distances: Dict[str, Dict[str, float]], return_to_start: bool = False) -> Tuple[List[str], float]:
    nodes = list(distances.keys())
    if not nodes:
        return [], 0.0

    best_path: List[str] = []
    best_length = float("inf")

    for start_node in nodes:
        remaining = [n for n in nodes if n != start_node]
        for perm in permutations(remaining):
            path = [start_node] + list(perm)
            if return_to_start:
                path.append(start_node)
            length = 0.0
            feasible = True
            for i in range(len(path) - 1):
                dist = distances.get(path[i], {}).get(path[i + 1])
                if dist is None:
                    feasible = False
                    break
                length += dist
            if feasible and length < best_length:
                best_length = length
                best_path = path

    return best_path, best_length


def solve_tsp_nearest_neighbor(distances: Dict[str, Dict[str, float]], start: str | None = None) -> Tuple[List[str], float]:
    if not distances:
        return [], 0.0
    nodes = list(distances.keys())
    if start is None:
        start = nodes[0]
    visited = [start]
    total = 0.0

    while len(visited) < len(nodes):
        current = visited[-1]
        candidates = distances.get(current, {})
        next_node = None
        next_dist = None
        for node, dist in candidates.items():
            if node in visited:
                continue
            if next_dist is None or dist < next_dist:
                next_node = node
                next_dist = dist
        if next_node is None:
            break
        visited.append(next_node)
        total += next_dist or 0.0

    return visited, total
