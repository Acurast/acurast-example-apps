"""laya.serve plus CORS and a small RSS fetcher, for the browser demos.

Same env vars as `python -m laya.serve` (LAYA_HOST, LAYA_PORT, LAYA_MODELS,
LAYA_API_KEY, ...). Auth is still the bearer token: CORS only lets browsers
make the request, it grants nothing without the key.

GET /feed?url=<rss or atom url> fetches a news feed server-side, because most
feeds don't send CORS headers. Same bearer token; public http(s) hosts only.

GET /instance describes the phone serving this (country, chip, RAM, processor
address, decisions served). No request logging: access logs are off.
"""
import ipaddress
import json
import os
import socket
import threading
import time
import urllib.parse
import urllib.request
from typing import Optional

import uvicorn
from fastapi import Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from laya.serve import create_app

API_KEY = os.environ.get("LAYA_API_KEY") or None
MAX_FEED_BYTES = 2_000_000

app = create_app()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


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


@app.middleware("http")
async def _count_decisions(request, call_next):
    response = await call_next(request)
    if request.url.path == "/v1/systemone" and request.method == "POST" and response.status_code == 200:
        DECISIONS["count"] += 1
        _count("decision", request.query_params.get("demo") or "api")
    return response


def _count(event: str, page: str):
    event, page = event[:40], page[:40]
    if event not in EVENTS and len(EVENTS) >= MAX_EVENT_KEYS:
        return
    pages = EVENTS.setdefault(event, {})
    if page in pages or sum(len(v) for v in EVENTS.values()) < MAX_EVENT_KEYS:
        pages[page] = pages.get(page, 0) + 1


@app.api_route("/hit", methods=["GET", "POST"])
def hit(e: str = "view", p: str = "?"):
    """Page events from the demos (view, share, outgoing clicks). Counted, not logged."""
    _count(e, p)
    return Response(status_code=204)


@app.get("/stats")
def stats():
    return {"decisions": DECISIONS["count"], "uptime_s": int(time.time() - STARTED), "events": EVENTS,
            "instance": {k: INSTANCE.get(k) for k in ("country", "chip", "deployment_id")}}


@app.get("/instance")
def instance():
    """Public facts about the phone serving this, for the demo pages' badge."""
    return {**INSTANCE, "decisions": DECISIONS["count"], "uptime_s": int(time.time() - STARTED)}


def _public_url(url: str) -> str:
    """Reject non-http(s) URLs and hosts that resolve to loopback/private ranges,
    so the fetcher can't be pointed at the phone or its local network."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(status_code=400, detail="only http(s) URLs are allowed")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise HTTPException(status_code=400, detail="cannot resolve host")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise HTTPException(status_code=400, detail="host is not public")
    return url


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    # Re-check every redirect target, not just the first URL.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_CheckedRedirects)


@app.get("/feed")
def feed(url: str, authorization: Optional[str] = Header(default=None)):
    if API_KEY is not None and authorization != "Bearer " + API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")
    req = urllib.request.Request(_public_url(url), headers={"User-Agent": "laya-demo/1.0 (+rss)"})
    try:
        with _opener.open(req, timeout=15) as resp:
            data = resp.read(MAX_FEED_BYTES)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 -- report fetch problems to the page
        raise HTTPException(status_code=502, detail=f"feed fetch failed: {e}")
    # Only pass through things that look like feeds: this is not a general web fetcher.
    head = data[:4000].lower()
    if not any(tag in head for tag in (b"<rss", b"<feed", b"<rdf")):
        raise HTTPException(status_code=415, detail="not an RSS/Atom feed")
    return Response(content=data, media_type="application/xml")


@app.get("/config.js")
def demo_config():
    """Defaults for the demo pages. The key is only handed out when
    LAYA_DEMO_PUBLIC=1: then anyone with the URL can use the demos (and the API)."""
    key = API_KEY if os.environ.get("LAYA_DEMO_PUBLIC") == "1" and API_KEY else ""
    js = "window.LAYA_DEFAULTS = { url: location.origin, key: %s };\n" % json.dumps(key)
    return Response(content=js, media_type="application/javascript", headers={"Cache-Control": "no-store"})


LLMS_TXT = """# Laya on Acurast

> Laya is an open, non-generative "System 1" decision model: send it a state and
> typed questions, it answers with a choice, a score or a yes/no probability, plus
> probabilities. This instance runs on an Android phone in the Acurast Cloud.

Base URL: @BASE@
Auth: header `Authorization: Bearer @KEY@`
Speed: about 2-4 s per question (CPU on a phone). Context: about 512 tokens, English.
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
- Fewer questions per request is faster: each question adds about 1-2 s here.
- Give options short, distinct descriptions. Scores are more stable than yes/no.
- Probabilities are not perfectly calibrated; treat low confidence as "unsure".
- This URL changes when the deployment is redeployed.
"""


@app.get("/llms.txt")
def llms_txt(request: Request):
    """How to use this instance, for AI agents (llmstxt.org). Uses the public URL
    it was requested on; includes the key only in public demo mode."""
    host = request.headers.get("host", "localhost")
    base = ("http://" if host.startswith(("127.", "localhost")) else "https://") + host
    key = API_KEY if os.environ.get("LAYA_DEMO_PUBLIC") == "1" and API_KEY else "<LAYA_API_KEY>"
    text = LLMS_TXT.replace("@BASE@", base).replace("@KEY@", key)
    _count("fetch", "llms.txt")
    return Response(content=text, media_type="text/plain; charset=utf-8", headers={"Cache-Control": "no-store"})


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


def _page(request: Request, name: str):
    path = os.path.join(DEMO_DIR, name + ".html")
    if name not in PAGES or not os.path.isfile(path):
        raise HTTPException(status_code=404)
    host = request.headers.get("host", "localhost")
    base = ("http://" if host.startswith(("127.", "localhost")) else "https://") + host
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
    html = open(path, encoding="utf-8").read().replace("</head>", meta + "\n</head>", 1)
    return Response(content=html, media_type="text/html; charset=utf-8")


@app.get("/")
def index_page(request: Request):
    return _page(request, "index")


@app.get("/{name}.html")
def demo_page(request: Request, name: str):
    return _page(request, name)


# Everything else of the demo pages (css, js, images), at / (mounted last so the API routes win).
DEMO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demos")
if os.path.isdir(DEMO_DIR):
    app.mount("/", StaticFiles(directory=DEMO_DIR, html=True), name="demos")


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("LAYA_HOST", "0.0.0.0"),
        port=int(os.environ.get("LAYA_PORT", "8000")),
        log_level=os.environ.get("LAYA_LOG_LEVEL", "info"),
        access_log=False,  # no per-request logs on the phone
    )
