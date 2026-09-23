"""Laya's /v1/systemone API plus the browser demos, on the Python standard library.

No web framework: `http.server` serves the API, the demo pages and a few helper
routes. Inference runs on ONNX Runtime via `laya_onnx.py` (no PyTorch).

Env: LAYA_HOST, LAYA_PORT, LAYA_API_KEY (bearer token, required by start.sh),
LAYA_MODEL_DIR (default /opt/laya/model), LAYA_THREADS (default: one per
performance core; the efficiency cores are left out),
LAYA_DEMO_PUBLIC=1 to hand the key to the demo pages.

GET /feed?url=<rss or atom url> fetches a news feed server-side, because most
feeds don't send CORS headers. Same bearer token; public http(s) hosts only.

GET /instance describes the phone serving this (country, chip, RAM, processor
address, decisions served). No request logging.
"""
import hmac
import ipaddress
import json
import mimetypes
import os
import socket
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from laya_onnx import Laya

API_KEY = os.environ.get("LAYA_API_KEY") or None
MAX_FEED_BYTES = 2_000_000
# Guardrails for remote input, same limits as laya.serve.
MAX_QUESTIONS = 64
MAX_STATE_CHARS = 50000
MAX_BODY_BYTES = 2 * 1024 * 1024
DEMO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demos")

MODEL = Laya(os.environ.get("LAYA_MODEL_DIR", "/opt/laya/model"), threads=int(os.environ.get("LAYA_THREADS") or 0))


class HTTPError(Exception):
    def __init__(self, status: int, detail: str = ""):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ---------------------------------------------------------------- about this phone
STARTED = time.time()
DECISIONS = {"count": 0}
# Aggregate counters only: event -> page -> count. No IPs, no IDs, no cookies.
EVENTS = {}
MAX_EVENT_KEYS = 500
INSTANCE = {}

# Common Snapdragon codes -> marketing names; others are shown as reported.
SOCS = {
    "SM8150": "Snapdragon 855", "SM8250": "Snapdragon 865", "SM8350": "Snapdragon 888",
    "SM8450": "Snapdragon 8 Gen 1", "SM8475": "Snapdragon 8+ Gen 1", "SM8550": "Snapdragon 8 Gen 2",
    "SM8650": "Snapdragon 8 Gen 3", "SM8750": "Snapdragon 8 Elite", "SM7325": "Snapdragon 778G",
    "SM7450": "Snapdragon 7 Gen 1", "SM6375": "Snapdragon 695", "SDM845": "Snapdragon 845",
}


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def _bridge(method: str):
    """One JSON-RPC call to the Acurast processor (same bridge tunnel.py uses)."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(5)
        sock.connect("\0" + os.environ["BRIDGE_SOCKET"])
        sock.sendall((json.dumps({"jsonrpc": "2.0", "method": method, "params": [], "id": 1}) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
    finally:
        sock.close()
    return json.loads(buf.split(b"\n", 1)[0]).get("result") or {}


def _gather_instance():
    info = {}
    hw = next((l.split(":", 1)[1].strip() for l in _read("/proc/cpuinfo").splitlines() if l.startswith("Hardware")), "")
    code = next((w for w in hw.replace(",", " ").split() if w.upper().startswith(("SM", "SDM"))), "")
    info["chip"] = SOCS.get(code.upper(), hw or "unknown chip")
    info["cores"] = os.cpu_count()
    freqs = [int(_read(f"/sys/devices/system/cpu/cpu{i}/cpufreq/cpuinfo_max_freq") or 0) for i in range(16)]
    info["max_ghz"] = round(max(freqs) / 1e6, 2) if any(freqs) else None
    mem = next((l for l in _read("/proc/meminfo").splitlines() if l.startswith("MemTotal")), "")
    info["ram_gb"] = round(int(mem.split()[1]) / 1024 / 1024, 1) if mem else None
    for key, method, pick in [
        ("processor_version", "processor_version", lambda r: r.get("version")),
        ("deployment_id", "deployment_id", lambda r: r.get("id")),
        ("processor", "deployment_assignedProcessors", lambda r: next(iter(r.get("processors") or {}), None)),
    ]:
        try:
            info[key] = pick(_bridge(method))
        except Exception:  # noqa: BLE001 -- best effort, not on every processor build
            info[key] = None
    # Country only (never city or IP), so the phone's owner stays unidentifiable.
    try:
        with urllib.request.urlopen(urllib.request.Request("https://ipapi.co/json/", headers={"User-Agent": "laya-demo/1.0"}), timeout=10) as r:
            geo = json.load(r)
        info["country"], info["country_code"] = geo.get("country_name"), geo.get("country_code")
    except Exception:  # noqa: BLE001
        info["country"], info["country_code"] = None, None
    INSTANCE.update(info)


threading.Thread(target=_gather_instance, daemon=True).start()


def _count(event: str, page: str):
    event, page = event[:40], page[:40]
    if event not in EVENTS and len(EVENTS) >= MAX_EVENT_KEYS:
        return
    pages = EVENTS.setdefault(event, {})
    if page in pages or sum(len(v) for v in EVENTS.values()) < MAX_EVENT_KEYS:
        pages[page] = pages.get(page, 0) + 1


def _public_url(url: str) -> str:
    """Reject non-http(s) URLs and hosts that resolve to loopback/private ranges,
    so the fetcher can't be pointed at the phone or its local network."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPError(400, "only http(s) URLs are allowed")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise HTTPError(400, "cannot resolve host")
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise HTTPError(400, "host is not public")
    return url


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    # Re-check every redirect target, not just the first URL.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_CheckedRedirects)


LLMS_TXT = """# Laya on Acurast

> Laya is an open, non-generative "System 1" decision model: send it a state and
> typed questions, it answers with a choice, a score or a yes/no probability, plus
> probabilities. This instance runs on an Android phone in the Acurast Cloud.

Base URL: @BASE@
Auth: header `Authorization: Bearer @KEY@`
Speed: about 0.3-1 s per question (CPU on a phone). Context: about 512 tokens, English.
Model: https://huggingface.co/convaiinnovations/laya (Apache-2.0). Acurast: https://acurast.com

## Endpoints

- POST @BASE@/v1/systemone: make decisions (below)
- GET @BASE@/health: status and loaded model (no auth)
- GET @BASE@/feed?url=<rss or atom url>: fetch a news feed server-side (same auth)
- GET @BASE@/instance: which phone serves this (country, chip, RAM, processor address, decisions served)

## Request

{"state": <any JSON describing the situation>, "questions": {"<name>": <question>, ...}}

Question types:
- choice: {"type": "choice", "instructions": "...", "criteria": {"<option_id>": "<description>", ...}}
  -> answers.<name>.choice (an option_id) and answers.<name>.probabilities
- score: {"type": "score", "instructions": "...", "criteria": ["<level 0>", "<level 1>", ...]}
  -> answers.<name>.score (0 to levels-1, fractional) and probabilities per level
- noul: {"type": "noul", "instructions": "..."}
  -> answers.<name>.noul (probability of "yes", 0 to 1)

## Example

curl -s @BASE@/v1/systemone \\
  -H 'Authorization: Bearer @KEY@' -H 'Content-Type: application/json' \\
  -d '{"state": {"message": "You charged me twice, I want my money back today!"},
       "questions": {
         "intent": {"type": "choice", "instructions": "What does the customer want in `message`?",
                    "criteria": {"refund": "money back", "technical_help": "a bug or outage", "other": "anything else"}},
         "urgent": {"type": "noul", "instructions": "Does `message` communicate time pressure?"}}}' | jq
# no jq? pipe into: python3 -m json.tool

Response (shortened):
{"answers": {"intent": {"type": "choice", "choice": "refund", "probabilities": {"refund": 0.99, ...}, "confidence": 0.99},
             "urgent": {"type": "noul", "noul": 0.24, "confidence": 0.76}}, "usage": {"input_tokens": 120, "output_tokens": 0}}

## Tips

- Put the facts in `state`; refer to its fields with backticks in instructions, e.g. `message`.
- Fewer questions per request is faster: each question adds about 0.3-0.5 s here.
- Give options short, distinct descriptions. Scores are more stable than yes/no.
- Probabilities are not perfectly calibrated; treat low confidence as "unsure".
- This URL changes when the deployment is redeployed.
"""

# Link previews (Open Graph / X cards) need absolute URLs and crawlers don't run
# JavaScript, so the server adds them to every page it serves.
PAGES = {
    "index": ("Laya on Acurast: decisions made on a phone", "Snake, Tetris, a mail sorter, a dating app and more, every decision made by an open AI model on a phone in the Acurast Cloud."),
    "snake": ("Laya plays Snake", "Every move decided by an open AI model running on a phone in the Acurast Cloud."),
    "tetris": ("Laya plays Tetris", "An open AI model on a phone picks every placement."),
    "spam": ("Laya sorts the mail", "Inbox, spam or phishing? A phone in the Acurast Cloud reads your mail. No account, not logged."),
    "tinder": ("Laya swipes for you", "Tell it what you want in a partner for life. A phone swipes through history's strangest profiles."),
    "newsroom": ("Laya Newsroom", "News, satire, clickbait or manipulation? Judged by an open AI model on a phone. Bring any RSS feed."),
    "guard": ("Jailbreak the guard", "Can you sneak a prompt past an AI guard running on a phone in the Acurast Cloud?"),
    "chat": ("Laya moderates a live chat", "Toxic, spam or scam? A phone moderates a stream chat in real time."),
    "hotline": ("The anonymous decision hotline", "Stuck on a decision? A phone you'll never meet decides. No account, not logged."),
    "api": ("Laya API on Acurast", "One HTTP call: send a state and typed questions, a phone in the Acurast Cloud decides. curl, JS, Python, llms.txt."),
    "stats": ("Laya on Acurast: live stats", "How many decisions phones in the Acurast Cloud made for these demos."),
}


def _demo_key() -> str:
    """The API key is only handed out when LAYA_DEMO_PUBLIC=1: then anyone with the URL
    can use the demos (and the API)."""
    return API_KEY if os.environ.get("LAYA_DEMO_PUBLIC") == "1" and API_KEY else ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "laya"
    sys_version = ""

    def log_message(self, *args):  # no per-request logs on the phone
        pass

    # ------------------------------------------------------------ plumbing
    def _send(self, status: int, body: bytes = b"", ctype: str = "application/json", headers=None):
        self.send_response(status)
        # CORS only lets browsers make the request; it grants nothing without the key.
        self.send_header("Access-Control-Allow-Origin", "*")
        if body or status != 204:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status: int = 200):
        self._send(status, json.dumps(obj).encode())

    def _base(self) -> str:
        host = self.headers.get("Host", "localhost")
        return ("http://" if host.startswith(("127.", "localhost")) else "https://") + host

    def _check_auth(self):
        if API_KEY is not None and not hmac.compare_digest(self.headers.get("Authorization") or "", "Bearer " + API_KEY):
            raise HTTPError(401, "invalid or missing bearer token")

    def _handle(self, routes):
        url = urllib.parse.urlsplit(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            fn = routes.get(url.path)
            if fn is not None:
                fn(query)
            elif self.command in ("GET", "HEAD"):
                self._static(url.path)
            else:
                raise HTTPError(405, "method not allowed")
        except HTTPError as e:
            # The request body may be unread: close instead of reusing the connection.
            self.close_connection = True
            self._send(e.status, json.dumps({"detail": e.detail}).encode(), headers={"Connection": "close"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):  # CORS preflight
        self._send(204, headers={"Access-Control-Allow-Methods": "GET, POST",
                                 "Access-Control-Allow-Headers": "Authorization, Content-Type",
                                 "Access-Control-Max-Age": "600"})

    def do_GET(self):
        self._handle({"/health": self.health, "/hit": self.hit, "/stats": self.stats, "/instance": self.instance,
                      "/feed": self.feed, "/config.js": self.config_js, "/llms.txt": self.llms_txt,
                      "/": lambda q: self.page("index")})

    do_HEAD = do_GET

    def do_POST(self):
        self._handle({"/v1/systemone": self.systemone, "/hit": self.hit})

    # ------------------------------------------------------------ routes
    def health(self, q):
        self._json({"status": "ok", "loaded": MODEL.loaded, "device": "cpu", "cores": MODEL.cores})

    def systemone(self, q):
        self._check_auth()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HTTPError(400, "invalid Content-Length")
        if length > MAX_BODY_BYTES:
            raise HTTPError(413, "request body too large")
        try:
            body = json.loads(self.rfile.read(length) or b"null")
        except ValueError:
            raise HTTPError(400, "request body must be valid JSON")
        if not isinstance(body, dict) or "questions" not in body:
            raise HTTPError(400, "request body must be an object with a 'questions' field")
        state, questions = body.get("state"), body["questions"]
        if not isinstance(questions, dict):
            raise HTTPError(400, "'questions' must be an object")
        if len(questions) > MAX_QUESTIONS:
            raise HTTPError(413, "too many questions (%d > %d)" % (len(questions), MAX_QUESTIONS))
        state_len = len(state) if isinstance(state, str) else len(json.dumps(state, default=str))
        if state_len > MAX_STATE_CHARS:
            raise HTTPError(413, "state too large (%d > %d chars)" % (state_len, MAX_STATE_CHARS))
        try:
            result = MODEL.predict(state, questions)
        except ValueError as e:  # question validation errors name the question and what to fix
            raise HTTPError(422, str(e))
        except Exception:  # noqa: BLE001 -- never leak paths/weights/OOM text to clients
            raise HTTPError(500, "inference failed")
        DECISIONS["count"] += 1
        _count("decision", q.get("demo") or "api")
        self._json(result)

    def hit(self, q):
        """Page events from the demos (view, share, outgoing clicks). Counted, not logged."""
        _count(q.get("e", "view"), q.get("p", "?"))
        self._send(204)

    def stats(self, q):
        self._json({"decisions": DECISIONS["count"], "uptime_s": int(time.time() - STARTED), "events": EVENTS,
                    "instance": {k: INSTANCE.get(k) for k in ("country", "chip", "deployment_id")}})

    def instance(self, q):
        """Public facts about the phone serving this, for the demo pages' badge."""
        self._json({**INSTANCE, "decisions": DECISIONS["count"], "uptime_s": int(time.time() - STARTED)})

    def feed(self, q):
        self._check_auth()
        if "url" not in q:
            raise HTTPError(422, "missing 'url'")
        req = urllib.request.Request(_public_url(q["url"]), headers={"User-Agent": "laya-demo/1.0 (+rss)"})
        try:
            with _opener.open(req, timeout=15) as resp:
                data = resp.read(MAX_FEED_BYTES)
        except HTTPError:
            raise
        except Exception as e:  # noqa: BLE001 -- report fetch problems to the page
            raise HTTPError(502, f"feed fetch failed: {e}")
        # Only pass through things that look like feeds: this is not a general web fetcher.
        if not any(tag in data[:4000].lower() for tag in (b"<rss", b"<feed", b"<rdf")):
            raise HTTPError(415, "not an RSS/Atom feed")
        self._send(200, data, "application/xml")

    def config_js(self, q):
        js = "window.LAYA_DEFAULTS = { url: location.origin, key: %s };\n" % json.dumps(_demo_key())
        self._send(200, js.encode(), "application/javascript", {"Cache-Control": "no-store"})

    def llms_txt(self, q):
        """How to use this instance, for AI agents (llmstxt.org). Uses the public URL
        it was requested on; includes the key only in public demo mode."""
        text = LLMS_TXT.replace("@BASE@", self._base()).replace("@KEY@", _demo_key() or "<LAYA_API_KEY>")
        _count("fetch", "llms.txt")
        self._send(200, text.encode(), "text/plain; charset=utf-8", {"Cache-Control": "no-store"})

    def page(self, name: str):
        path = os.path.join(DEMO_DIR, name + ".html")
        if name not in PAGES or not os.path.isfile(path):
            raise HTTPError(404, "Not Found")
        base = self._base()
        title, desc = PAGES[name]
        esc = lambda t: t.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
        meta = (
            f'<meta name="description" content="{esc(desc)}">'
            f'<meta property="og:type" content="website"><meta property="og:site_name" content="Acurast">'
            f'<meta property="og:title" content="{esc(title)}"><meta property="og:description" content="{esc(desc)}">'
            f'<meta property="og:url" content="{base}/{name}.html">'
            f'<meta name="twitter:site" content="@Acurast">'
            f'<meta name="twitter:title" content="{esc(title)}"><meta name="twitter:description" content="{esc(desc)}">'
        )
        # Preview image only if it was deployed (the Hub playground doesn't copy images).
        if os.path.isfile(os.path.join(DEMO_DIR, "og", name + ".png")):
            meta += (f'<meta property="og:image" content="{base}/og/{name}.png">'
                     f'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="{base}/og/{name}.png">')
        else:
            meta += '<meta name="twitter:card" content="summary">'
        with open(path, encoding="utf-8") as f:
            html = f.read().replace("</head>", meta + "\n</head>", 1)
        self._send(200, html.encode(), "text/html; charset=utf-8")

    def _static(self, path: str):
        """Demo pages get link previews; css, js and images are served as they are."""
        if path.endswith(".html") and "/" not in path[1:]:
            return self.page(path[1:-5])
        full = os.path.realpath(os.path.join(DEMO_DIR, urllib.parse.unquote(path).lstrip("/")))
        if not full.startswith(os.path.realpath(DEMO_DIR) + os.sep) or not os.path.isfile(full):
            raise HTTPError(404, "Not Found")
        with open(full, "rb") as f:
            self._send(200, f.read(), mimetypes.guess_type(full)[0] or "application/octet-stream")


if __name__ == "__main__":
    server = ThreadingHTTPServer((os.environ.get("LAYA_HOST", "0.0.0.0"), int(os.environ.get("LAYA_PORT", "8000"))), Handler)
    server.daemon_threads = True
    server.serve_forever()
