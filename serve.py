#!/usr/bin/env python3
"""Tiny dual-stack static file server for local Web Dashers dev/preview.

Serves the directory this script lives in. Usage: python3 serve.py [port]
Avoids the `--directory` flag (some launchers strip `--` options).
"""
import os
import sys
import socket
import socketserver
import http.server

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4321


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        # Keep code uncached so edits always show on reload, but cache the
        # heavy static assets (atlases, images, audio) so reloads stay fast.
        p = self.path.split("?")[0].lower()
        if p.endswith(".js") or p.endswith(".html") or p.endswith("/"):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        super().end_headers()


class DualStackServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    address_family = socket.AF_INET6  # accepts both ::1 and 127.0.0.1

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        return super().server_bind()


with DualStackServer(("", PORT), Handler) as httpd:
    print(f"Web Dashers dev server on http://localhost:{PORT}")
    httpd.serve_forever()
