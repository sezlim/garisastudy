#!/usr/bin/env python3
"""Lightweight local web server for GarisaStudy.

Serves ./web static files and provides a zero-token file-backed API
(GET/POST /api/briefings) that persists shared briefings directly into
web/data/user_briefings.json so PC and mobile devices see the exact same
briefings regardless of which account ID logs in.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT_DIR / "web"
BRIEFINGS_FILE = WEB_DIR / "data" / "user_briefings.json"
FILE_LOCK = threading.Lock()
MAX_PAYLOAD_BYTES = 50 * 1024 * 1024  # 50 MB (supports embedded screenshots/images)


def load_briefings_file() -> dict:
    if not BRIEFINGS_FILE.exists():
        return {}
    try:
        raw = BRIEFINGS_FILE.read_text(encoding="utf-8").strip()
        if not raw:
            return {}
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_briefings_file(data: dict) -> None:
    BRIEFINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(data, ensure_ascii=False, indent=2)
    fd, tmp_path = tempfile.mkstemp(
        prefix="user_briefings_", suffix=".tmp", dir=str(BRIEFINGS_FILE.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(serialized)
        os.replace(tmp_path, BRIEFINGS_FILE)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


class GarisaRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def end_headers(self):
        # Prevent stale caching of briefings data across PC/mobile
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") or parsed.path.endswith("user_briefings.json"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/briefings":
            with FILE_LOCK:
                data = load_briefings_file()
            self._send_json({"ok": True, "briefings": data})
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/briefings/publish":
            self._handle_publish_to_git()
            return
        if parsed.path != "/api/briefings":
            self._send_json({"ok": False, "error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        try:
            content_len = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json({"ok": False, "error": "Invalid Content-Length"}, HTTPStatus.BAD_REQUEST)
            return

        if content_len <= 0 or content_len > MAX_PAYLOAD_BYTES:
            self._send_json(
                {"ok": False, "error": "Payload size out of bounds"},
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE if content_len > MAX_PAYLOAD_BYTES else HTTPStatus.BAD_REQUEST,
            )
            return

        raw = self.rfile.read(content_len)
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "Invalid JSON"}, HTTPStatus.BAD_REQUEST)
            return

        if not isinstance(body, dict):
            self._send_json({"ok": False, "error": "JSON object expected"}, HTTPStatus.BAD_REQUEST)
            return

        now_ms = int(time.time() * 1000)

        with FILE_LOCK:
            data = load_briefings_file()

            # Bulk import mode: { "briefings": { "T01": { ... }, ... } }
            if isinstance(body.get("briefings"), dict):
                for code, rec in body["briefings"].items():
                    if not isinstance(code, str) or not code.strip():
                        continue
                    if isinstance(rec, dict) and isinstance(rec.get("html"), str):
                        data[code] = {
                            "topicCode": code,
                            "html": rec["html"],
                            "updatedAt": int(rec.get("updatedAt") or now_ms),
                        }
                save_briefings_file(data)
                self._send_json({"ok": True, "count": len(data), "updatedAt": now_ms})
                return

            # Single topic save/delete mode: { "topicCode": "T01", "html": "...", "empty": false }
            topic_code = str(body.get("topicCode") or "").strip()
            if not topic_code:
                self._send_json({"ok": False, "error": "topicCode is required"}, HTTPStatus.BAD_REQUEST)
                return

            is_empty = bool(body.get("empty"))
            html = str(body.get("html") or "")
            updated_at = int(body.get("updatedAt") or now_ms)

            if is_empty or not html.strip():
                data.pop(topic_code, None)
            else:
                data[topic_code] = {
                    "topicCode": topic_code,
                    "html": html,
                    "updatedAt": updated_at,
                }

            save_briefings_file(data)
            self._send_json({"ok": True, "topicCode": topic_code, "updatedAt": updated_at})

    def _handle_publish_to_git(self):
        rel_path = "web/data/user_briefings.json"
        with FILE_LOCK:
            if not BRIEFINGS_FILE.exists():
                save_briefings_file({})

            def run_git(*args):
                return subprocess.run(
                    ["git", *args],
                    cwd=str(ROOT_DIR),
                    capture_output=True,
                    text=True,
                    timeout=60,
                )

            try:
                add_res = run_git("add", "--", rel_path)
                if add_res.returncode != 0:
                    self._send_json(
                        {"ok": False, "error": (add_res.stderr or add_res.stdout or "git add 실패").strip()},
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                    )
                    return

                diff_res = run_git("diff", "--cached", "--quiet", "--", rel_path)
                if diff_res.returncode == 0:
                    self._send_json({
                        "ok": True,
                        "status": "no_changes",
                        "message": "변경된 브리핑이 없어 이미 최신 상태입니다.",
                    })
                    return

                commit_res = run_git(
                    "commit", "-m", "chore: update user briefings", "--", rel_path
                )
                if commit_res.returncode != 0:
                    self._send_json(
                        {"ok": False, "error": (commit_res.stderr or commit_res.stdout or "git commit 실패").strip()},
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                    )
                    return

                push_res = run_git("push")
                if push_res.returncode != 0:
                    self._send_json(
                        {"ok": False, "error": (push_res.stderr or push_res.stdout or "git push 실패").strip()},
                        HTTPStatus.INTERNAL_SERVER_ERROR,
                    )
                    return

                self._send_json({
                    "ok": True,
                    "status": "pushed",
                    "message": "Git 업로드 완료! 약 1분 뒤 GitHub Pages(외부 모바일)에 반영됩니다.",
                })
            except subprocess.TimeoutExpired:
                self._send_json(
                    {"ok": False, "error": "git push 시간이 초과되었습니다. 네트워크를 확인하세요."},
                    HTTPStatus.GATEWAY_TIMEOUT,
                )
            except FileNotFoundError:
                self._send_json(
                    {"ok": False, "error": "PC에 git이 설치되어 있지 않습니다."},
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            except Exception as exc:
                self._send_json(
                    {"ok": False, "error": str(exc)},
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )


def main() -> None:
    parser = argparse.ArgumentParser(description="GarisaStudy local web & briefings server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    args = parser.parse_args()

    if not BRIEFINGS_FILE.exists():
        save_briefings_file({})

    server = ThreadingHTTPServer((args.host, args.port), GarisaRequestHandler)
    print(f"Serving {WEB_DIR} on http://{args.host}:{args.port} (briefings file: {BRIEFINGS_FILE})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
