"""A small S3 client for Cloudflare R2, standard library only.

R2's S3 API is used rather than wrangler because wrangler can neither list the
objects in a bucket nor read an object's metadata, and the upload needs both
to skip what has not changed, to verify and to prune. A single PUT may carry
up to about 5 GiB on R2; the largest file here is 54 MB, so no multipart.

Credentials come from the environment only:

  CLOUDFLARE_ACCOUNT_ID        gives the endpoint https://<id>.r2.cloudflarestorage.com
  R2_ENDPOINT                  overrides the endpoint (a jurisdiction endpoint, or a test server)
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY     an R2 API token's S3 keys, or instead
  CLOUDFLARE_API_TOKEN_R2      a Cloudflare API token with R2 write permission: R2
                               accepts the token's id as the access key and the
                               SHA-256 of its value as the secret. The id is
                               looked up with the token verify call.
  CLOUDFLARE_API_TOKEN         used when CLOUDFLARE_API_TOKEN_R2 is not set, for a
                               setup with one token for everything (the name
                               wrangler and the deployment use)
"""
import base64
import datetime
import hashlib
import hmac
import http.client
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
API_BASE = "https://api.cloudflare.com/client/v4"
RETRY_STATUS = (429, 500, 502, 503, 504)


class S3Error(Exception):
    def __init__(self, status, code, message):
        super().__init__(f"HTTP {status}" + (f" {code}" if code else "") + (f": {message}" if message else ""))
        self.status = status
        self.code = code


class CredentialsError(Exception):
    pass


class NoCredentials(CredentialsError):
    """Nothing is configured at all, as opposed to configured and refused."""


def quote(text, safe="-_.~"):
    return urllib.parse.quote(text, safe=safe)


def canonical_query(query):
    return "&".join(f"{quote(key)}={quote(str(value))}" for key, value in sorted((query or {}).items()))


def sign(method, path, query, headers, payload_hash, access_key, secret_key, region, amz_date):
    """The Authorization header (AWS Signature Version 4) for a request that sends exactly `headers`."""
    signed = sorted((name.lower(), " ".join(str(value).split())) for name, value in headers.items())
    names = ";".join(name for name, _ in signed)
    request = "\n".join([method, quote(path, "/-_.~"), canonical_query(query),
                         "".join(f"{name}:{value}\n" for name, value in signed), names, payload_hash])
    scope = f"{amz_date[:8]}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(request.encode()).hexdigest()])
    key = ("AWS4" + secret_key).encode()
    for part in (amz_date[:8], region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={names}, Signature={signature}"


# Environment variables that may hold the API token, in order of preference.
TOKEN_NAMES = ("CLOUDFLARE_API_TOKEN_R2", "CLOUDFLARE_API_TOKEN")


def token_id(token, account, api_base=API_BASE, name="CLOUDFLARE_API_TOKEN_R2"):
    """The id of a Cloudflare API token. User tokens and account-owned tokens have separate verify calls."""
    paths = ["/user/tokens/verify"]
    if account:
        paths.append(f"/accounts/{account}/tokens/verify")
    if token.startswith("cfat_"):  # the account-owned format
        paths.reverse()
    problems, refused = [], False
    for path in paths:
        request = urllib.request.Request(api_base + path, headers={"Authorization": f"Bearer {token}", "User-Agent": "arcade-assets"})
        for attempt in range(3):
            if attempt:
                time.sleep(2 ** attempt)
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    result = json.load(response).get("result") or {}
            except urllib.error.HTTPError as error:
                if error.code in RETRY_STATUS:
                    problem = f"{path}: HTTP {error.code}"
                    continue
                problem, refused = f"{path}: HTTP {error.code}", True
                break
            except (OSError, ValueError) as error:  # the network, or an answer that is not JSON
                problem = f"{path}: {error}"
                continue
            if result.get("id") and result.get("status", "active") == "active":
                return result["id"]
            problem, refused = f"{path}: token status {result.get('status')!r}", True
            break
        problems.append(problem)
    raise CredentialsError((f"{name} was not accepted by Cloudflare" if refused else f"could not reach Cloudflare to look up {name}")
                           + " (" + "; ".join(problems) + ")")


class Client:
    def __init__(self, endpoint, access_key, secret_key, region="auto"):
        parts = urllib.parse.urlsplit(endpoint)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise CredentialsError(f"not an endpoint URL: {endpoint}")
        self.secure = parts.scheme == "https"
        self.host = parts.netloc
        self.endpoint = f"{parts.scheme}://{parts.netloc}"
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.attempts = 5
        self.backoff = 1.0   # seconds before the first retry, doubled each time
        self.timeout = 300

    @classmethod
    def from_env(cls, env=os.environ):
        """A client from the environment. NoCredentials says what to set when nothing is; a
        token that Cloudflare refuses is a plain CredentialsError."""
        account = env.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
        endpoint = env.get("R2_ENDPOINT", "").strip() or (f"https://{account}.r2.cloudflarestorage.com" if account else "")
        if not endpoint:
            raise NoCredentials("set CLOUDFLARE_ACCOUNT_ID (or R2_ENDPOINT)")
        access, secret = env.get("R2_ACCESS_KEY_ID", "").strip(), env.get("R2_SECRET_ACCESS_KEY", "").strip()
        if not (access and secret):
            # The token kept for R2 alone wins over the general one, which usually
            # belongs to the deployment and may not have R2 permissions.
            name = next((n for n in TOKEN_NAMES if env.get(n, "").strip()), None)
            if not name:
                raise NoCredentials("set CLOUDFLARE_API_TOKEN_R2 (or CLOUDFLARE_API_TOKEN), or R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY")
            token = env[name].strip()
            access = token_id(token, account, env.get("CLOUDFLARE_API_BASE_URL", "").strip().rstrip("/") or API_BASE, name)
            secret = hashlib.sha256(token.encode()).hexdigest()
        return cls(endpoint, access, secret)

    def request(self, method, path, query=None, headers=None, file=None, payload_hash=EMPTY_SHA256, sink=None, ok=(200, 204)):
        """One signed request, retried on network errors and 429/5xx.

        `file` is a path whose content is the body (its SHA-256 is `payload_hash`).
        `sink`, called once per attempt, returns the function that receives the
        response body in blocks instead of it being returned.
        Returns (status, headers, body); a status outside `ok` raises S3Error.
        """
        target = quote(path, "/-_.~") + ("?" + canonical_query(query) if query else "")
        last = None
        for attempt in range(self.attempts):
            if attempt:
                time.sleep(self.backoff * 2 ** (attempt - 1))
            sent = {"Host": self.host, "x-amz-content-sha256": payload_hash, **(headers or {}),
                    "x-amz-date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")}
            sent["Authorization"] = sign(method, path, query, sent, payload_hash, self.access_key, self.secret_key, self.region, sent["x-amz-date"])
            sent["Content-Length"] = str(os.path.getsize(file) if file else 0)
            connection = (http.client.HTTPSConnection if self.secure else http.client.HTTPConnection)(self.host, timeout=self.timeout, blocksize=1 << 20)
            try:
                body = open(file, "rb") if file else None
                try:
                    connection.request(method, target, body=body, headers=sent)
                    response = connection.getresponse()
                    wanted = response.status in ok
                    data = b""
                    if sink and wanted:
                        write = sink()
                        for block in iter(lambda: response.read(1 << 20), b""):
                            write(block)
                    else:
                        data = response.read()
                finally:
                    if body:
                        body.close()
            except (OSError, http.client.HTTPException) as error:
                last = S3Error(0, "", f"{type(error).__name__}: {error}")
                continue
            finally:
                connection.close()
            if wanted:
                return response.status, response.headers, data
            code, message = error_details(data)
            if response.status in (401, 403) and not message:  # a HEAD answer has no body to explain itself
                message = "access refused: check the credentials and that the token may write to R2"
            last = S3Error(response.status, code, message)
            if response.status not in RETRY_STATUS:
                break
        raise last

    def bucket_exists(self, bucket):
        try:
            self.request("HEAD", f"/{bucket}")
            return True
        except S3Error as error:
            if error.status == 404:
                return False
            raise

    def create_bucket(self, bucket):
        self.request("PUT", f"/{bucket}")

    def head(self, bucket, key):
        """{"bytes", "sha256", "etag"} of an object, or None when there is none. sha256 is what the upload recorded."""
        try:
            _, headers, _ = self.request("HEAD", f"/{bucket}/{key}")
        except S3Error as error:
            if error.status == 404:
                return None
            raise
        return {"bytes": int(headers.get("Content-Length", -1)), "sha256": headers.get("x-amz-meta-sha256"), "etag": (headers.get("ETag") or "").strip('"')}

    def put(self, bucket, key, file, sha256, md5, content_type):
        """Upload a file. The server checks the body against both hashes (hex)
        and refuses one that differs; the SHA-256 is kept as the object's metadata."""
        headers = {"Content-Type": content_type, "Content-MD5": base64.b64encode(bytes.fromhex(md5)).decode(), "x-amz-meta-sha256": sha256}
        self.request("PUT", f"/{bucket}/{key}", headers=headers, file=file, payload_hash=sha256)

    def get_digest(self, bucket, key):
        """Download an object without keeping it: (bytes, sha256) of its content."""
        state = {}

        def begin():
            state["hash"], state["bytes"] = hashlib.sha256(), 0

            def write(block):
                state["hash"].update(block)
                state["bytes"] += len(block)
            return write
        self.request("GET", f"/{bucket}/{key}", sink=begin)
        return state["bytes"], state["hash"].hexdigest()

    def delete(self, bucket, key):
        self.request("DELETE", f"/{bucket}/{key}")

    def list(self, bucket):
        """Every object as {key: bytes}."""
        found, token = {}, None
        while True:
            query = {"list-type": "2"}
            if token:
                query["continuation-token"] = token
            _, _, data = self.request("GET", f"/{bucket}", query=query)
            page = strip_namespaces(xml.etree.ElementTree.fromstring(data))
            for item in page.iter("Contents"):
                found[item.findtext("Key")] = int(item.findtext("Size") or 0)
            token = page.findtext("NextContinuationToken")
            if page.findtext("IsTruncated") != "true" or not token:
                return found


def strip_namespaces(element):
    for node in element.iter():
        node.tag = node.tag.rsplit("}", 1)[-1]
    return element


def error_details(data):
    """Code and Message of an S3 error document, when the body is one."""
    try:
        document = strip_namespaces(xml.etree.ElementTree.fromstring(data))
        return document.findtext("Code") or "", document.findtext("Message") or ""
    except xml.etree.ElementTree.ParseError:
        return "", data[:200].decode("utf-8", "replace").strip()
