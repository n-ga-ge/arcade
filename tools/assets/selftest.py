#!/usr/bin/env python3
"""Tests for upload.py and fetch.py. No Cloudflare account and no game data needed.

  python3 -I tools/assets/selftest.py [-v] [TestName ...]

The files are random bytes named after the catalogue's games. upload.py runs
against the S3 stub (s3stub.py) and fetch.py against a small HTTP server, both
on free local ports. The request signer is checked against the examples in
AWS's Signature Version 4 documentation, so it is not only tested against
itself.
"""
import functools
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # no __pycache__ in the checkout
sys.path.insert(0, HERE)  # -I leaves the script's folder off the path
import common  # noqa: E402
import s3  # noqa: E402
import s3stub  # noqa: E402

SLUGS = common.catalogue_slugs()
SECRETS = ("CLOUDFLARE_API_TOKEN_R2", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_BASE_URL", "R2_ENDPOINT", "R2_ACCESS_KEY_ID",
           "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ASSETS_URL", "ASSETS_TOKEN")


def run(script, *args, env=None):
    """Run one of the scripts with only the given credentials in its environment."""
    clean = {name: value for name, value in os.environ.items() if name not in SECRETS}
    return subprocess.run([sys.executable, "-I", os.path.join(HERE, script), *args], env={**clean, **(env or {})}, capture_output=True, text=True)


def make_files(folder):
    """A fake firmware and one fake zip per catalogue game; returns the options that point the scripts at them."""
    os.makedirs(os.path.join(folder, "zips"))
    with open(os.path.join(folder, "NGAGE.ROM"), "wb") as fh:
        fh.write(os.urandom(5000))
    for slug in SLUGS:
        with open(os.path.join(folder, "zips", slug + ".zip"), "wb") as fh:
            fh.write(os.urandom(1000 + len(slug)))
    # --games names a folder with no dumps, so nothing can be packed from real ones
    return ["--fw", os.path.join(folder, "NGAGE.ROM"), "--out", os.path.join(folder, "zips"), "--games", os.path.join(folder, "none"),
            "--manifest", os.path.join(folder, "assets.json")]


class Signer(unittest.TestCase):
    """The four examples from "Authenticating Requests: Using the Authorization Header" in the S3 API reference."""
    ACCESS, SECRET = "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    HOST, DATE = "examplebucket.s3.amazonaws.com", "20130524T000000Z"

    def signature(self, method, path, query, headers, payload=s3.EMPTY_SHA256):
        headers = {"Host": self.HOST, "x-amz-content-sha256": payload, "x-amz-date": self.DATE, **headers}
        return s3.sign(method, path, query, headers, payload, self.ACCESS, self.SECRET, "us-east-1", self.DATE).rsplit("=", 1)[1]

    def test_get_object(self):
        self.assertEqual(self.signature("GET", "/test.txt", None, {"Range": "bytes=0-9"}),
                         "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")

    def test_put_object(self):
        payload = hashlib.sha256(b"Welcome to Amazon S3.").hexdigest()
        headers = {"Date": "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY"}
        self.assertEqual(self.signature("PUT", "/test$file.text", None, headers, payload),
                         "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd")

    def test_query_without_value(self):
        self.assertEqual(self.signature("GET", "/", {"lifecycle": ""}, {}),
                         "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543")

    def test_list_objects(self):
        self.assertEqual(self.signature("GET", "/", {"max-keys": "2", "prefix": "J"}, {}),
                         "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7")


class Upload(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="assets-selftest-")
        self.addCleanup(shutil.rmtree, self.folder)
        self.files = make_files(self.folder)
        self.stub = s3stub.Stub(("127.0.0.1", 0), os.path.join(self.folder, "r2"), page=7).start()  # small pages: listing must follow them
        self.addCleanup(self.stub.server_close)
        self.addCleanup(self.stub.shutdown)
        self.endpoint = f"http://127.0.0.1:{self.stub.server_address[1]}"
        self.env = {"R2_ENDPOINT": self.endpoint, "R2_ACCESS_KEY_ID": "test", "R2_SECRET_ACCESS_KEY": "test"}
        self.bucket = os.path.join(self.folder, "r2", "bkt")

    def upload(self, *args, env=None, code=0):
        result = run("upload.py", *self.files, "--bucket", "bkt", *args, env=self.env if env is None else env)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def puts(self):
        return [path for method, path in self.stub.log if method == "PUT" and path != "/bkt"]

    def stored(self, key):
        with open(os.path.join(self.bucket, *key.split("/")), "rb") as fh:
            return fh.read()

    def test_whole_cycle(self):
        # no manifest yet: refuse
        self.assertIn("--write-manifest", self.upload(code=1))
        self.assertIn(f"firmware and {len(SLUGS)} games", self.upload("--write-manifest"))
        manifest = common.load_manifest(os.path.join(self.folder, "assets.json"))
        self.assertEqual(sorted(manifest["games"]), SLUGS)
        self.assertEqual(manifest["fw"]["bytes"], 5000)

        # without credentials: a dry run checks the files against the manifest, a real run fails
        self.assertIn("the bucket was not looked at", self.upload("--dry-run", env={}))
        self.assertIn("CLOUDFLARE_ACCOUNT_ID", self.upload(env={}, code=1))

        # a dry run with credentials changes nothing
        out = self.upload("--dry-run")
        self.assertIn("would create it", out)
        self.assertIn(f"0 unchanged, {len(SLUGS) + 1} would upload", out)
        self.assertFalse(os.path.exists(self.bucket))
        self.assertEqual(self.puts(), [])

        # the first upload creates the bucket and stores everything, byte for byte
        out = self.upload()
        self.assertIn("creating it", out)
        self.assertIn(f"0 unchanged, {len(SLUGS) + 1} uploaded", out)
        self.assertEqual(len(self.puts()), len(SLUGS) + 1)
        with open(os.path.join(self.folder, "NGAGE.ROM"), "rb") as fh:
            self.assertEqual(self.stored("NGAGE.ROM"), fh.read())
        self.assertEqual(hashlib.sha256(self.stored(f"games/{SLUGS[0]}.zip")).hexdigest(), manifest["games"][SLUGS[0]]["sha256"])
        self.assertEqual(self.stub.meta[("bkt", f"games/{SLUGS[0]}.zip")]["sha256"], manifest["games"][SLUGS[0]]["sha256"])
        self.assertEqual(self.stub.meta[("bkt", f"games/{SLUGS[0]}.zip")]["type"], "application/zip")

        # nothing changed: nothing uploaded
        del self.stub.log[:]
        self.assertIn(f"{len(SLUGS) + 1} unchanged, 0 uploaded", self.upload())
        self.assertEqual(self.puts(), [])
        self.assertIn(f"{len(SLUGS) + 1} of {len(SLUGS) + 1} objects match", self.upload("--verify"))
        self.assertIn("content hashed", self.upload("--verify", "--download"))

        # a file that differs from the committed manifest stops the upload before the bucket is touched
        changed = SLUGS[1]
        with open(os.path.join(self.folder, "zips", changed + ".zip"), "ab") as fh:
            fh.write(b"changed")
        del self.stub.log[:]
        out = self.upload(code=1)
        self.assertIn("REFUSING TO UPLOAD", out)
        self.assertIn(f"games/{changed}.zip", out)
        self.assertEqual(self.stub.log, [])
        self.assertIn("REFUSING", self.upload("--dry-run", env={}, code=1))
        self.upload("--only", SLUGS[0])  # other files are not held up by it

        # once the manifest is regenerated, only that file goes up
        out = self.upload("--write-manifest", "--only", changed)
        self.assertIn("1 changed", out)
        del self.stub.log[:]
        self.assertIn(f"{len(SLUGS)} unchanged, 1 uploaded", self.upload())
        self.assertEqual(self.puts(), [f"/bkt/games/{changed}.zip"])
        self.assertTrue(self.stored(f"games/{changed}.zip").endswith(b"changed"))

    def test_verify_and_prune(self):
        self.upload("--write-manifest")
        self.assertIn("does not exist", self.upload("--verify", code=1))
        self.upload()
        victim, other, gone = (f"games/{slug}.zip" for slug in SLUGS[:3])

        # same size, different bytes: only hashing the content can tell
        path = os.path.join(self.bucket, *victim.split("/"))
        with open(path, "r+b") as fh:
            fh.write(b"\0\0\0\0")
        self.upload("--verify")
        out = self.upload("--verify", "--download", code=1)
        self.assertIn("WRONG CONTENT", out)
        self.assertIn(f"{len(SLUGS)} of {len(SLUGS) + 1} objects match", out)

        # replaced by something else (other size, no recorded hash), and removed
        with open(os.path.join(self.bucket, *other.split("/")), "ab") as fh:
            fh.write(b"x")
        self.stub.meta[("bkt", "NGAGE.ROM")]["sha256"] = None
        os.remove(os.path.join(self.bucket, *gone.split("/")))
        out = self.upload("--verify", code=1)
        for expected in ("WRONG SIZE", "WRONG HASH recorded: none", "MISSING from the bucket", f"{len(SLUGS) - 2} of {len(SLUGS) + 1} objects match"):
            self.assertIn(expected, out)

        # the next upload repairs exactly those; the same-size damage is invisible to it, as to --verify, and needs --force
        del self.stub.log[:]
        self.assertIn(f"{len(SLUGS) - 2} unchanged, 3 uploaded", self.upload())
        self.assertEqual(sorted(self.puts()), sorted(["/bkt/NGAGE.ROM", "/bkt/" + other, "/bkt/" + gone]))
        self.assertIn("1 uploaded", self.upload("--force", "--only", SLUGS[0]))
        self.upload("--verify", "--download")

        # objects outside the catalogue are reported, and removed only with --prune
        for key in ("games/retired.zip", "stray.bin"):
            with open(os.path.join(self.bucket, *key.split("/")), "wb") as fh:
                fh.write(b"old")
        self.assertIn("--prune removes it", self.upload())
        self.assertIn("2 would be removed", self.upload("--prune", "--dry-run"))
        self.assertTrue(os.path.exists(os.path.join(self.bucket, "stray.bin")))
        self.assertIn("2 removed", self.upload("--prune"))
        self.assertFalse(os.path.exists(os.path.join(self.bucket, "stray.bin")))
        self.assertFalse(os.path.exists(os.path.join(self.bucket, "games", "retired.zip")))
        self.assertTrue(os.path.exists(os.path.join(self.bucket, "NGAGE.ROM")))

    def test_failures(self):
        self.upload("--write-manifest")
        self.assertIn("not in the catalogue", self.upload("--only", "no-such-game", code=1))
        # wrong keys: every request is refused and the run fails
        out = self.upload(env={**self.env, "R2_SECRET_ACCESS_KEY": "wrong"}, code=1)
        self.assertIn("HTTP 403: access refused", out)
        self.assertFalse(os.path.exists(self.bucket))
        # a missing zip (no dump to pack it from) fails before anything is uploaded
        os.remove(os.path.join(self.folder, "zips", SLUGS[0] + ".zip"))
        self.assertIn(f"games/{SLUGS[0]}.zip: no file", self.upload(code=1))
        self.assertEqual(self.puts(), [])
        # transient server errors are retried
        self.stub.fail_next = 2
        self.assertIn("1 uploaded", self.upload("--only", "fw"))

    def test_api_token_credentials(self):
        """An API token alone: the S3 keys are the token's id and the SHA-256 of its value."""
        self.stub.token = "cf-token-for-the-test"
        self.stub.keys = {s3stub.TOKEN_ID: hashlib.sha256(b"cf-token-for-the-test").hexdigest()}
        env = {"R2_ENDPOINT": self.endpoint, "CLOUDFLARE_API_BASE_URL": self.endpoint + "/client/v4", "CLOUDFLARE_API_TOKEN": "cf-token-for-the-test"}
        self.upload("--write-manifest")
        self.assertIn("2 uploaded", self.upload("--only", "fw", SLUGS[0], env=env))
        self.assertIn("was not accepted", self.upload("--only", "fw", env={**env, "CLOUDFLARE_API_TOKEN": "another"}, code=1))
        # a refused token is not "no credentials": the dry run fails too
        self.assertIn("was not accepted", self.upload("--dry-run", "--only", "fw", env={**env, "CLOUDFLARE_API_TOKEN": "another"}, code=1))
        # the token kept for R2 wins over the general one, whichever of the two is right
        self.upload("--only", "fw", env={**env, "CLOUDFLARE_API_TOKEN": "another", "CLOUDFLARE_API_TOKEN_R2": "cf-token-for-the-test"})
        self.assertIn("CLOUDFLARE_API_TOKEN_R2 was not accepted", self.upload("--only", "fw", env={**env, "CLOUDFLARE_API_TOKEN_R2": "another"}, code=1))


class AssetServer(http.server.SimpleHTTPRequestHandler):
    token = None
    fail_next = 0
    requests = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        cls = AssetServer
        cls.requests.append(self.path)
        if cls.token and self.headers.get("Authorization") != f"Bearer {cls.token}":
            return self.send_error(401)
        if cls.fail_next > 0:
            cls.fail_next -= 1
            return self.send_error(503)
        super().do_GET()


class Fetch(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="assets-selftest-")
        self.addCleanup(shutil.rmtree, self.folder)
        self.manifest = make_files(self.folder)[-1]
        # the served tree has the layout below /assets/
        served = os.path.join(self.folder, "served", "assets")
        os.makedirs(served)
        shutil.copy(os.path.join(self.folder, "NGAGE.ROM"), served)
        shutil.copytree(os.path.join(self.folder, "zips"), os.path.join(served, "games"))
        self.served = served
        common.write_manifest({"fw": self.entry(common.FW), "games": {slug: self.entry(slug) for slug in SLUGS}}, self.manifest)
        AssetServer.token, AssetServer.fail_next, AssetServer.requests = None, 0, []
        handler = functools.partial(AssetServer, directory=os.path.join(self.folder, "served"))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/assets/"
        self.out = os.path.join(self.folder, "testdata")

    def entry(self, name):
        size, sha256 = common.digest(os.path.join(self.served, *common.object_key(name).split("/")), "sha256")
        return {"bytes": size, "sha256": sha256}

    def fetch(self, *args, env=None, code=0, manifest=None):
        result = run("fetch.py", *args, "--out", self.out, "--manifest", manifest or self.manifest, "--retries", "2",
                     env={"ASSETS_URL": self.url} if env is None else env)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_download_then_skip(self):
        slug = SLUGS[0]
        out = self.fetch("--fw", slug)
        self.assertEqual(out.count("downloaded"), 2)
        for key in ("NGAGE.ROM", f"games/{slug}.zip"):
            with open(os.path.join(self.out, *key.split("/")), "rb") as got, open(os.path.join(self.served, *key.split("/")), "rb") as want:
                self.assertEqual(got.read(), want.read())
        del AssetServer.requests[:]
        self.assertEqual(self.fetch("--fw", slug).count("already there"), 2)
        self.assertEqual(AssetServer.requests, [])
        # a damaged local copy is fetched again
        with open(os.path.join(self.out, "NGAGE.ROM"), "r+b") as fh:
            fh.write(b"\0\0\0\0")
        out = self.fetch("--fw", slug)
        self.assertEqual((out.count("downloaded"), out.count("already there")), (1, 1))

    def test_all(self):
        out = self.fetch("--all", env={"ASSETS_URL": self.url.rstrip("/")})  # a base without the slash works too
        self.assertEqual(out.count("downloaded"), len(SLUGS) + 1)
        self.assertEqual(len(os.listdir(os.path.join(self.out, "games"))), len(SLUGS))

    def test_hash_mismatch(self):
        slug = SLUGS[0]
        manifest = common.load_manifest(self.manifest)
        manifest["games"][slug]["sha256"] = "0" * 64
        wrong = os.path.join(self.folder, "wrong.json")
        common.write_manifest(manifest, wrong)
        out = self.fetch("--fw", slug, manifest=wrong, code=1)
        self.assertIn("SHA-256 mismatch", out)
        self.assertIn("1 of 2 files could not be fetched", out)
        self.assertEqual(len(AssetServer.requests), 2)  # a wrong hash is not retried
        self.assertTrue(os.path.exists(os.path.join(self.out, "NGAGE.ROM")))
        self.assertEqual(os.listdir(os.path.join(self.out, "games")), [])  # nothing unverified is left behind

    def test_errors(self):
        slug = SLUGS[0]
        self.assertIn("ASSETS_URL is not set", self.fetch("--fw", env={}, code=1))
        self.assertIn("no usable entry", self.fetch("no-such-game", code=1))
        # a malformed entry is reported, not tripped over
        manifest = common.load_manifest(self.manifest)
        manifest["games"][slug] = {"sha256": manifest["games"][slug]["sha256"]}
        broken = os.path.join(self.folder, "broken.json")
        with open(broken, "w") as fh:
            json.dump(manifest, fh)
        self.assertIn(f"no usable entry in {broken} for: {slug}", self.fetch(slug, manifest=broken, code=1))
        os.remove(os.path.join(self.served, "games", slug + ".zip"))
        self.assertIn("HTTP 404", self.fetch(slug, code=1))
        # cut short on the server: retried, then reported
        with open(os.path.join(self.served, "NGAGE.ROM"), "r+b") as fh:
            fh.truncate(100)
        out = self.fetch("--fw", code=1)
        self.assertIn("got 100 of 5000 bytes", out)
        self.assertIn("after 3 attempts", out)

    def test_token_and_retry(self):
        AssetServer.token = "secret-token"
        self.assertIn("ASSETS_TOKEN is not set", self.fetch("--fw", code=1))
        self.assertIn("ASSETS_TOKEN was refused", self.fetch("--fw", env={"ASSETS_URL": self.url, "ASSETS_TOKEN": "wrong"}, code=1))
        AssetServer.fail_next = 1
        out = self.fetch("--fw", env={"ASSETS_URL": self.url, "ASSETS_TOKEN": "secret-token"})
        self.assertIn("HTTP 503", out)
        self.assertIn("downloaded", out)


class SiteStep(unittest.TestCase):
    def test_manifest_matches_the_catalogue_and_is_published(self):
        manifest = common.load_manifest()
        self.assertEqual(sorted(manifest["games"]), SLUGS)
        for value in [manifest["fw"], *manifest["games"].values()]:
            self.assertEqual(sorted(value), ["bytes", "sha256"])
            self.assertRegex(value["sha256"], "^[0-9a-f]{64}$")
        dist = tempfile.mkdtemp(prefix="assets-selftest-")
        self.addCleanup(shutil.rmtree, dist)
        step = os.path.join(common.ROOT, "tools", "site", "steps", "20-assets.py")
        subprocess.run([sys.executable, "-I", step, dist], check=True, env={**os.environ, "ARCADE_ROOT": common.ROOT})
        with open(os.path.join(dist, "catalog", "assets.json")) as fh:
            self.assertEqual(json.load(fh), manifest)


if __name__ == "__main__":
    unittest.main()
