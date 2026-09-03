# SPDX-License-Identifier: AGPL-3.0-only
"""troth as the memory of Hermes Agent.

The provider asks the troth proxy, on this machine, for the context a prompt
gets (identity, standing rules, recall, open goals) before each model call,
places the session context in the system prompt once, and records every
completed turn into the substrate. Configuration: ``proxy_url`` (default
``http://127.0.0.1:8000``) and ``agent_id`` (default ``hermes``).
"""

import json
import os
import urllib.request
import urllib.error

try:  # inside Hermes
    from agent.memory_provider import MemoryProvider  # type: ignore
except Exception:  # anywhere else (tests, tooling)
    class MemoryProvider(object):  # type: ignore
        pass


DEFAULT_PROXY = "http://127.0.0.1:8000"


class TrothMemoryProvider(MemoryProvider):
    def __init__(self):
        self._proxy = os.environ.get("TROTH_PROXY_URL", DEFAULT_PROXY).rstrip("/")
        self._agent_id = os.environ.get("TROTH_AGENT_ID", "hermes")
        self._session_id = ""
        self._cwd = os.getcwd()
        self._load_saved()

    # ── identity ────────────────────────────────────────────────────────
    @property
    def name(self):
        return "troth"

    def _load_saved(self):
        home = os.environ.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
        try:
            with open(os.path.join(home, "troth.json"), "r", encoding="utf-8") as f:
                saved = json.load(f) or {}
            self._proxy = str(saved.get("proxy_url") or self._proxy).rstrip("/")
            self._agent_id = str(saved.get("agent_id") or self._agent_id)
        except Exception:
            pass

    def _post(self, path, body, timeout=40.0):
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self._proxy + path, data=data, headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def _get(self, path, timeout=5.0):
        with urllib.request.urlopen(self._proxy + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    # ── lifecycle ───────────────────────────────────────────────────────
    def is_available(self):
        try:
            return str(self._get("/health").get("status")) == "ok"
        except Exception:
            return False

    def initialize(self, session_id, **kwargs):
        self._session_id = str(session_id or "")
        cwd = kwargs.get("cwd") or kwargs.get("working_directory")
        if cwd:
            self._cwd = str(cwd)

    def get_config_schema(self):
        return [
            {"key": "proxy_url", "description": "The troth proxy on this machine", "default": DEFAULT_PROXY, "required": False},
            {"key": "agent_id", "description": "How the substrate names this surface", "default": "hermes", "required": False},
        ]

    def save_config(self, values, hermes_home):
        values = values or {}
        self._proxy = str(values.get("proxy_url") or DEFAULT_PROXY).rstrip("/")
        self._agent_id = str(values.get("agent_id") or "hermes")
        try:
            with open(os.path.join(hermes_home, "troth.json"), "w", encoding="utf-8") as f:
                json.dump({"proxy_url": self._proxy, "agent_id": self._agent_id}, f)
        except Exception:
            pass

    def get_tool_schemas(self):
        # Tools reach Hermes through troth's MCP servers (docs/MCP-HOST-INSTALL.md).
        return []

    def handle_tool_call(self, tool_name, args, **kwargs):
        return None

    # ── what the model sees ─────────────────────────────────────────────
    def system_prompt_block(self):
        try:
            r = self._post("/api/context/session", {"session_id": self._session_id, "cwd": self._cwd})
            return str(r.get("context") or "")
        except Exception:
            return ""

    def prefetch(self, query, *args, **kwargs):
        session_id = kwargs.get("session_id") or self._session_id
        try:
            r = self._post("/api/context/prompt", {"prompt": str(query or ""), "session_id": session_id, "cwd": self._cwd})
            return str(r.get("context") or "")
        except Exception:
            return ""

    def queue_prefetch(self, *args, **kwargs):
        return None

    # ── what the substrate keeps ────────────────────────────────────────
    def _record(self, role, content):
        if not content:
            return
        try:
            self._post("/api/substrate/dialogue/record-turn", {
                "conv_id": self._session_id or "hermes",
                "session_id": self._session_id,
                "agent_id": self._agent_id,
                "role": role,
                "content": str(content),
                "cwd": self._cwd,
            }, timeout=10.0)
        except Exception:
            pass

    def sync_turn(self, *args, **kwargs):
        user = kwargs.get("user_message") or kwargs.get("user") or kwargs.get("query") or (args[0] if len(args) > 0 else None)
        assistant = kwargs.get("assistant_message") or kwargs.get("assistant") or kwargs.get("response") or (args[1] if len(args) > 1 else None)
        self._record("user", user)
        self._record("assistant", assistant)

    def on_memory_write(self, *args, **kwargs):
        text = kwargs.get("content") or kwargs.get("text") or (args[0] if args else None)
        if text:
            self._record("assistant", "[memory] " + str(text))

    def on_pre_compress(self, *args, **kwargs):
        return None

    def on_session_end(self, *args, **kwargs):
        return None

    def shutdown(self):
        return None


def register(ctx):
    ctx.register_memory_provider(TrothMemoryProvider())
