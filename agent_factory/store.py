from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


class OrganizationStore:
    """Small JSON store for the MVP's operational state and audit trail.

    The store intentionally keeps manifests, hiring requests, memories, and
    events together so a restart can reconstruct the complete demo state.
    """

    def __init__(self, path: str | os.PathLike[str] = "data/organization.json") -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self.state: dict[str, Any] = {
            "version": 1,
            "agents": {},
            "recruitment_requests": {},
            "memories": {},
            "events": [],
        }
        self.load()

    def load(self) -> None:
        with self._lock:
            if self.path.exists():
                self.state = json.loads(self.path.read_text(encoding="utf-8"))

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                prefix=f"{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(self.state, handle, indent=2, sort_keys=True)
                    handle.write("\n")
                os.replace(temp_name, self.path)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self.state)

    def append_event(self, event: dict[str, Any]) -> None:
        with self._lock:
            self.state["events"].append(event)
            self.save()
