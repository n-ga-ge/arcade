#!/usr/bin/env python3
"""A local stand-in for the R2 bucket, for testing upload.py without Cloudflare.

  python3 -I tools/assets/s3stub.py --root DIR [--port 8201] [--token T | --access-key K --secret-key S]

It speaks just the part of the S3 API upload.py uses (create/head bucket, put,
head, get, delete and list objects) and is strict where R2 is: a request whose
Signature V4 does not verify is refused, and so is a body that does not match
its Content-MD5 or x-amz-content-sha256. Objects are plain files under
DIR/<bucket>/<key>, so a test can damage one. With --token it also answers the
Cloudflare token verify call and accepts the S3 keys derived from that token.

  R2_ENDPOINT=http://127.0.0.1:8201 R2_ACCESS_KEY_ID=test R2_SECRET_ACCESS_KEY=test \\
    python3 -I tools/assets/upload.py --bucket test

Not a general S3 server and not for anything but tests.
"""
import argparse
import base64
import hashlib
import http.server
import json
import os
import re
import shutil
import sys
import threading
import urllib.parse
from xml.sax.saxutils import escape

sys.dont_write_bytecode = True  # no __pycache__ in the checkout
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
import s3  # noqa: E402

TOKEN_ID = "0123456789abcdef0123456789abcdef"


class Stub(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root, access_key="test", secret_key="test", token=None, page=1000):
        super().__init__(address, Handler)
        self.root = root
        self.token = token
        self.keys = {TOKEN_ID: hashlib.sha256(token.encode()).hexdigest()} if token else {access_key: secret_key}
        self.page = page          # objects per list page
        self.meta = {}            # (bucket, key) -> {"etag", "sha256", "type"}
        self.log = []             # (method, path) of every request that passed authentication
        self.fail_next = 0        # answer this many requests with 503 first
        self.lock = threading.Lock()

    def start(self):
        threading.Thread(target=self.serve_forever, daemon=True).start()
        return self


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body=b"", headers=None):
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if "Content-Length" not in (headers or {}):
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def error(self, status, code, message=""):
        self.reply(status, f"<?xml version=\"1.0\"?><Error><Code>{code}</Code><Message>{escape(message)}</Message></Error>".encode(), {"Content-Type": "application/xml"})

    def authentic(self, path, query, body):
        """Recompute the signature from the request as it arrived."""
        found = re.fullmatch(r"AWS4-HMAC-SHA256 Credential=([^/]+)/(\d{8})/([^/]+)/s3/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})",
                             self.headers.get("Authorization", ""))
        if not found or found.group(1) not in self.server.keys:
            return False
        access, _, region, names, _ = found.groups()
        payload = self.headers.get("x-amz-content-sha256", "")
        if not {"host", "x-amz-content-sha256", "x-amz-date"} <= set(names.split(";")) or payload != hashlib.sha256(body).hexdigest():
            return False
        signed = {name: self.headers.get(name, "") for name in names.split(";")}
        expected = s3.sign(self.command, path, {key: values[0] for key, values in query.items()}, signed, payload,
                           access, self.server.keys[access], region, self.headers.get("x-amz-date", ""))
        return expected == self.headers["Authorization"]

    def handle_request(self):
        server = self.server
        parts = urllib.parse.urlsplit(self.path)
        path, query = urllib.parse.unquote(parts.path), urllib.parse.parse_qs(parts.query, keep_blank_values=True)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if path == "/client/v4/user/tokens/verify":
            good = server.token and self.headers.get("Authorization") == f"Bearer {server.token}"
            result = {"success": True, "result": {"id": TOKEN_ID, "status": "active"}} if good else {"success": False, "result": None}
            return self.reply(200 if good else 401, json.dumps(result).encode(), {"Content-Type": "application/json"})
        with server.lock:
            if server.fail_next > 0:
                server.fail_next -= 1
                return self.error(503, "ServiceUnavailable", "injected failure")
        if not self.authentic(path, query, body):
            return self.error(403, "SignatureDoesNotMatch", "the request signature does not verify")
        with server.lock:
            server.log.append((self.command, path))
        bucket, _, key = path.lstrip("/").partition("/")
        folder = os.path.join(server.root, bucket)
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket) or ".." in key.split("/") or key.startswith("/"):
            return self.error(400, "InvalidRequest", "bad bucket or key")
        if not key:
            if self.command == "PUT":
                if os.path.isdir(folder):
                    return self.error(409, "BucketAlreadyOwnedByYou")
                os.makedirs(folder)
                return self.reply(200)
            if not os.path.isdir(folder):
                return self.error(404, "NoSuchBucket")
            if self.command == "HEAD":
                return self.reply(200)
            if self.command == "GET" and query.get("list-type") == ["2"]:
                return self.list_objects(folder, query)
            return self.error(400, "InvalidRequest")
        if not os.path.isdir(folder):
            return self.error(404, "NoSuchBucket")
        target = os.path.join(folder, *key.split("/"))
        if self.command == "PUT":
            md5 = hashlib.md5(body).digest()
            if "Content-MD5" in self.headers and self.headers["Content-MD5"] != base64.b64encode(md5).decode():
                return self.error(400, "BadDigest", "Content-MD5 does not match the body")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(body)
            with server.lock:
                server.meta[(bucket, key)] = {"etag": md5.hex(), "sha256": self.headers.get("x-amz-meta-sha256"), "type": self.headers.get("Content-Type")}
            return self.reply(200, headers={"ETag": f'"{md5.hex()}"'})
        if not os.path.isfile(target):
            return self.error(404, "NoSuchKey")
        if self.command == "DELETE":
            os.remove(target)
            server.meta.pop((bucket, key), None)
            return self.reply(204)
        meta = server.meta.get((bucket, key), {})
        headers = {"Content-Length": str(os.path.getsize(target)), "ETag": f'"{meta.get("etag", "")}"', "Content-Type": meta.get("type") or "application/octet-stream"}
        if meta.get("sha256"):
            headers["x-amz-meta-sha256"] = meta["sha256"]
        with open(target, "rb") as fh:
            return self.reply(200, fh.read(), headers)

    def list_objects(self, folder, query):
        keys = sorted(os.path.relpath(os.path.join(base, name), folder).replace(os.sep, "/") for base, _, names in os.walk(folder) for name in names)
        start = int(query.get("continuation-token", ["0"])[0])
        page = keys[start:start + self.server.page]
        more = start + len(page) < len(keys)
        items = "".join(f"<Contents><Key>{escape(key)}</Key><Size>{os.path.getsize(os.path.join(folder, *key.split('/')))}</Size></Contents>" for key in page)
        body = ('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f"<IsTruncated>{'true' if more else 'false'}</IsTruncated>" + (f"<NextContinuationToken>{start + len(page)}</NextContinuationToken>" if more else "")
                + items + "</ListBucketResult>")
        self.reply(200, body.encode(), {"Content-Type": "application/xml"})

    do_GET = do_HEAD = do_PUT = do_DELETE = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--root", required=True, help="folder the buckets are kept in")
    parser.add_argument("--port", type=int, default=8201)
    parser.add_argument("--access-key", default="test")
    parser.add_argument("--secret-key", default="test")
    parser.add_argument("--token", help="accept the keys derived from this Cloudflare API token instead")
    parser.add_argument("--page", type=int, default=1000, help="objects per list page")
    parser.add_argument("--clear", action="store_true", help="empty the folder first")
    args = parser.parse_args()
    if args.clear and os.path.isdir(args.root):
        shutil.rmtree(args.root)
    os.makedirs(args.root, exist_ok=True)
    stub = Stub(("127.0.0.1", args.port), args.root, args.access_key, args.secret_key, args.token, args.page)
    print(f"S3 stub on http://127.0.0.1:{args.port}, buckets in {args.root}", flush=True)
    stub.serve_forever()


if __name__ == "__main__":
    main()
