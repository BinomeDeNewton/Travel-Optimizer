"""Configuration helpers for filesystem layout and defaults."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PathsConfig:
    root: Path
    data_dir: Path
    outputs_dir: Path
    cache_dir: Path

    @staticmethod
    def from_root(root: Path) -> "PathsConfig":
        root = root.resolve()
        data_dir = root / "data"
        outputs_dir = root / "outputs"
        cache_dir = data_dir / "cache"
        return PathsConfig(root=root, data_dir=data_dir, outputs_dir=outputs_dir, cache_dir=cache_dir)


def resolve_repo_root() -> Path:
    env_root = Path.cwd()
    for parent in [env_root] + list(env_root.parents):
        if (parent / "pyproject.toml").exists():
            return parent
    return env_root


def load_paths() -> PathsConfig:
    return PathsConfig.from_root(resolve_repo_root())
