#!/usr/bin/env python3
"""A stand-in for GitLab's API, for the load test's issues: takes uploads and new issues, answers the reads the server makes.

Uploads are read to the end and thrown away, so the load test measures what Inklayer spends sending a comment's
screenshots and recordings to a tracker (up to about 58 MB a comment), not this server. Standard library only.
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import count

issue_numbers = count(1)
upload_numbers = count(1)
received = {"uploads": 0, "upload_bytes": 0, "issues": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # one line per request would drown the server log
        pass

    def drain(self):
        """Reads the request body to the end (chunked or not); returns its size."""
        size = 0
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                length = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if length == 0:
                    self.rfile.readline()
                    return size
                while length > 0:
                    got = len(self.rfile.read(min(length, 1 << 20)))
                    size += got
                    length -= got
                self.rfile.readline()
        length = int(self.headers.get("Content-Length") or 0)
        while length > 0:
            got = len(self.rfile.read(min(length, 1 << 20)))
            if got == 0:
                break
            size += got
            length -= got
        return size

    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def issue(self, iid):
        return {"iid": iid, "title": "Load test issue", "state": "opened", "web_url": f"https://gitlab.internal/acme/shop/-/issues/{iid}",
                "updated_at": "2026-01-01T00:00:00Z"}

    def do_GET(self):
        self.drain()
        path = self.path.split("?")[0]
        if path == "/stats":
            return self.reply(received)
        if m := re.search(r"/issues/(\d+)$", path):
            return self.reply(self.issue(int(m.group(1))))
        if path.endswith("/notes") or path.endswith("/issues") or path.endswith("/merge_requests"):
            return self.reply([])
        if re.search(r"/api/v4/projects/[^/]+$", path):
            return self.reply({"id": 1, "issues_enabled": True, "path_with_namespace": "acme/shop"})
        return self.reply({})

    def do_POST(self):
        size = self.drain()
        path = self.path.split("?")[0]
        if path.endswith("/uploads"):
            n = next(upload_numbers)
            received["uploads"] += 1
            received["upload_bytes"] += size
            return self.reply({"url": f"/uploads/{n}/file", "markdown": f"![file](/uploads/{n}/file)"}, 201)
        if path.endswith("/issues"):
            received["issues"] += 1
            return self.reply(self.issue(next(issue_numbers)), 201)
        if path.endswith("/notes"):
            return self.reply({"id": next(upload_numbers)}, 201)
        return self.reply({}, 201)

    def do_PUT(self):
        self.drain()
        self.reply({})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
