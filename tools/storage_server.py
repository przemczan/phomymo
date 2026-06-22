#!/usr/bin/env python3
"""
Simple shared storage server for Phomymo.

Mirrors what the browser keeps in localStorage (designs, presets, custom
printers, preferences) into a single JSON file on disk, so multiple browsers
pointed at the same server share the same data. No database, no auth -
single shared store by design.

Also serves the static app (same files `python -m http.server` would serve
from src/web) on the same port, so one process/one origin handles both the
SPA and the sync API - no CORS needed when used this way.

Usage:
    python tools/storage_server.py [--port 8090] [--data-file path/to/store.json] [--static-dir path/to/src/web]
"""

import argparse
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

LOCK = threading.Lock()


def load_store(data_file):
    if not os.path.exists(data_file):
        return {}
    try:
        with open(data_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_store(data_file, store):
    tmp_file = data_file + ".tmp"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2)
    os.replace(tmp_file, data_file)


def make_handler(data_file, static_dir):
    class StorageHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=static_dir, **kwargs)

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self):
            length = int(self.headers.get("Content-Length", 0))
            if length == 0:
                return {}
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))

        def _key_from_path(self):
            path = urlparse(self.path).path
            prefix = "/api/storage/"
            if not path.startswith(prefix):
                return None
            key = path[len(prefix):]
            return key or None

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            path = urlparse(self.path).path

            if not path.startswith("/api/storage"):
                # Not an API route - serve it as a static file, same as
                # `python -m http.server` would.
                super().do_GET()
                return

            with LOCK:
                store = load_store(data_file)
            if path == "/api/storage":
                self._send_json(200, store)
                return

            key = self._key_from_path()
            if key is None:
                self._send_json(404, {"error": "not found"})
                return

            entry = store.get(key)
            if entry is None:
                self._send_json(404, {"error": "not found"})
                return
            self._send_json(200, entry)

        def do_PUT(self):
            key = self._key_from_path()
            if key is None:
                self._send_json(404, {"error": "not found"})
                return

            try:
                body = self._read_json_body()
            except (ValueError, UnicodeDecodeError):
                self._send_json(400, {"error": "invalid JSON body"})
                return

            value = body.get("value")
            updated_at = body.get("updatedAt")
            if value is None or not isinstance(updated_at, (int, float)):
                self._send_json(400, {"error": "value and updatedAt are required"})
                return

            with LOCK:
                store = load_store(data_file)
                existing = store.get(key)
                if existing is not None and existing.get("updatedAt", 0) > updated_at:
                    self._send_json(409, {"error": "stale write", "current": existing})
                    return
                store[key] = {"value": value, "updatedAt": updated_at}
                save_store(data_file, store)

            self._send_json(200, store[key])

        def do_DELETE(self):
            key = self._key_from_path()
            if key is None:
                self._send_json(404, {"error": "not found"})
                return

            try:
                body = self._read_json_body()
            except (ValueError, UnicodeDecodeError):
                body = {}
            updated_at = body.get("updatedAt", 0)

            with LOCK:
                store = load_store(data_file)
                existing = store.get(key)
                if existing is not None and existing.get("updatedAt", 0) > updated_at:
                    self._send_json(409, {"error": "stale delete", "current": existing})
                    return
                if key in store:
                    del store[key]
                    save_store(data_file, store)

            self._send_json(200, {"deleted": key})

        def log_message(self, format, *args):
            print("[storage_server]", format % args)

    return StorageHandler


def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    parser = argparse.ArgumentParser(description="Phomymo shared storage server")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument(
        "--data-file",
        default=os.path.join(os.path.dirname(__file__), "storage_data", "store.json"),
    )
    parser.add_argument(
        "--static-dir",
        default=os.path.join(repo_root, "src", "web"),
        help="Directory to serve the app from (default: src/web)",
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.data_file)), exist_ok=True)

    handler = make_handler(args.data_file, os.path.abspath(args.static_dir))
    server = ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    print(f"Phomymo storage server listening on port {args.port}")
    print(f"Serving app from: {args.static_dir}")
    print(f"Data file: {args.data_file}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
