"""OpenAI-compatible Qwen3.5 server on MNN (https://github.com/alibaba/MNN), standard library only.

The only dependency is the MNN wheel (`pip install MNN`, installed by start.sh). On start the
server answers /health and /info right away, downloads the model from Hugging Face (pinned
revision, resumable, every file checked against the hash Hugging Face lists for it), loads it
and then serves:

  GET  /health               {"status": "ok" | "loading" | "error"}, 503 until loaded
  GET  /info                 phase, download progress, model, threads, phone, last request speed
  GET  /v1/models            OpenAI model list                    (Authorization: Bearer LLM_API_KEY)
  POST /v1/chat/completions  OpenAI chat API, "stream": true sends tokens as they are generated

Env: LLM_API_KEY (required), LLM_MODEL (0.8B | 4B | 9B, default 4B), LLM_THREADS (default:
pick_threads), LLM_THINKING (1 = think before answering by default; off when empty),
MODEL_DIR (default /root/models), WEB_PORT (default 8080).
"""
import codecs
import ctypes
import hashlib
import hmac
import http.client
import json
import os
import queue
import sys
import threading
import time
import traceback
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = os.environ.get("LLM_API_KEY", "")
SIZE = os.environ.get("LLM_MODEL") or "4B"
THINKING = os.environ.get("LLM_THINKING", "") == "1"
PORT = int(os.environ.get("WEB_PORT", "8080"))
# Hugging Face revisions of Alibaba's MNN exports (Apache-2.0), pinned so every phone runs the same files.
REVISIONS = {
    "0.8B": "3208b55b2e3c948016c9d380a697be881a1f12f8",
    "4B": "aa966261175a532d9906fa165c9d506d617320a9",
    "9B": "149e1e052267ffa377b87e3bb0ddb75f46217a9a",
}
REPO = f"taobao-mnn/Qwen3.5-{SIZE}-MNN"
MODEL_ID = REPO.split("/")[1]
MODEL_DIR = os.path.join(os.environ.get("MODEL_DIR", "/root/models"), MODEL_ID)
SKIP = ("README.md", ".gitattributes", "export_args.json", "visual.mnn", "visual.mnn.weight")  # visual = images only
UA = "acurast-cargo-llm-mnn/1.0 (+https://github.com/Acurast/acurast-example-apps)"
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_TOKENS = 8192
ROLES = {"system": "system", "developer": "system", "user": "user", "assistant": "assistant"}

STATE = {"phase": "starting", "model": MODEL_ID, "revision": REVISIONS.get(SIZE), "thinking_default": THINKING,
         "download": {"done_bytes": 0, "total_bytes": 0}, "load_seconds": None, "threads": None, "phone": {},
         "requests": 0, "last_request": None, "error": None}
MODEL = None
LOCK = threading.Lock()  # one model instance: one request at a time, the others wait
_sink = None  # queue that receives MNN's stdout during a request; None = copy it to stderr


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


# ---------------------------------------------------------------- threads
def pick_threads(speed, ratio=0.6):
    """speed: {core: cpu_capacity or max frequency} of the cores this job may use -> (cores, threads).
    A core counts as fast at `ratio` of the fastest one or more.

    Measured with MNN on Acurast phones: 8 threads on Snapdragon 8 Elite-class chips (no efficiency
    cores), 4 on big.LITTLE phones, where the fast cores would wait for the slow ones.
    """
    if not speed:
        return [], 4
    fast = sorted(c for c, s in speed.items() if s >= ratio * max(speed.values()))
    return fast, min(len(fast), 8 if len(fast) == len(speed) else 4)


def core_speeds():
    allowed = sorted(os.sched_getaffinity(0))
    # The kernel's rating, else max frequency. Efficiency cores rate 15-45 % of the fastest core
    # by cpu_capacity, but up to ~70 % by frequency (Snapdragon 8 Gen 3: A520 2.27 vs X4 3.3 GHz).
    for f, ratio in (("cpu_capacity", 0.6), ("cpufreq/cpuinfo_max_freq", 0.75)):
        speed = {c: _read(f"/sys/devices/system/cpu/cpu{c}/{f}") for c in allowed}
        if all(v.isdigit() for v in speed.values()):
            return allowed, {c: int(v) for c, v in speed.items()}, ratio
    return allowed, {}, 0.6


# ---------------------------------------------------------------- model
def _get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
        return json.load(r)


def _fetch(f, rev):
    """Download one file, resuming a partial one; keep it only if its hash matches the listing."""
    dest = os.path.join(MODEL_DIR, f["path"])
    dl = STATE["download"]
    if os.path.exists(dest):
        dl["done_bytes"] += f["size"]
        return
    part, url = dest + ".part", f"https://huggingface.co/{REPO}/resolve/{rev}/{f['path']}"
    base, error, stuck = dl["done_bytes"], None, 0
    size = lambda: os.path.getsize(part) if os.path.exists(part) else 0  # noqa: E731
    while (have := size()) < f["size"]:
        dl["done_bytes"] = base + have
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **({"Range": f"bytes={have}-"} if have else {})})
            with urllib.request.urlopen(req, timeout=60) as r, open(part, "ab" if have and r.status == 206 else "wb") as out:
                dl["done_bytes"] = base + (have if r.status == 206 else 0)
                for chunk in iter(lambda: r.read(1 << 20), b""):
                    out.write(chunk)
                    dl["done_bytes"] += len(chunk)
        except (OSError, http.client.HTTPException) as e:
            error = e
        # Phone connections drop: retry as long as bytes arrive, give up after 8 attempts in a row
        # without any. The partial file stays for the next start.
        stuck = 0 if size() > have else stuck + 1
        if stuck >= 8:
            raise RuntimeError(f"download of {f['path']} stalled: {error}")
        if stuck:
            log(f"download {f['path']}: {error}; retrying")
            time.sleep(5)
    # LFS files carry their sha256, small files the git blob sha1 (sha1 of "blob <size>\0" + content).
    lfs = f.get("lfs")
    h = hashlib.sha256() if lfs else hashlib.sha1(b"blob %d\0" % f["size"])
    with open(part, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != (lfs["oid"] if lfs else f["oid"]):
        os.remove(part)
        raise RuntimeError(f"{f['path']}: hash mismatch after download")
    os.rename(part, dest)


def _prepare():
    global MODEL
    try:
        if SIZE not in REVISIONS:
            raise RuntimeError(f"LLM_MODEL must be one of {list(REVISIONS)}, got {SIZE!r}")
        rev = REVISIONS[SIZE]
        STATE["phase"] = "download"
        files = [f for f in _get_json(f"https://huggingface.co/api/models/{REPO}/tree/{rev}")
                 if f["type"] == "file" and f["path"] not in SKIP]
        STATE["download"]["total_bytes"] = sum(f["size"] for f in files)
        os.makedirs(MODEL_DIR, exist_ok=True)
        for f in files:
            _fetch(f, rev)

        STATE["phase"] = "load"
        t0 = time.time()
        import MNN.llm as llm  # after main() redirected stdout: MNN prints on import
        m = llm.create(os.path.join(MODEL_DIR, "config.json"))
        # MNN builds its sampler in load(), so sampling is fixed here. The export ships 1.0 / 0.95 (meant
        # for thinking); direct answers use 0.7 / 0.8. use_template: off, this server applies the chat template itself.
        m.set_config({"thread_num": STATE["threads"], "use_template": False,
                      **({} if THINKING else {"temperature": 0.7, "topP": 0.8})})
        if m.load() is False:
            raise RuntimeError("MNN failed to load the model (see stderr)")
        MODEL = m
        STATE["load_seconds"] = round(time.time() - t0, 1)
        STATE["phase"] = "ready"
        log(f"{MODEL_ID} ready: {STATE['threads']} threads, loaded in {STATE['load_seconds']} s")
    except Exception as e:  # noqa: BLE001 -- shown in /info and /health
        traceback.print_exc()
        STATE["phase"], STATE["error"] = "error", str(e)


# ---------------------------------------------------------------- generation
# MNN streams tokens only to C stdout (response(prompt, True)), and its Python binding crashes the
# process if you read its context while a token ends mid UTF-8 character. So main() points fd 1 at a
# pipe and complete() reads the tokens from there. MNN also prints each prompt and answer to stdout;
# they stay in this pipe and never reach the phone's log.
TAIL = b"[MNNLLM] response: \n"  # what the binding prints after a streamed response


def _pump(fd):
    while True:
        chunk = os.read(fd, 65536)
        sink = _sink
        if sink is not None:
            sink.put(chunk)
        else:
            sys.stderr.buffer.write(chunk)
            sys.stderr.flush()


def _held(buf, marker):
    """Length of the longest end of buf that may be the start of marker: wait for more bytes first."""
    return next((n for n in range(min(len(buf), len(marker)), 0, -1) if buf.endswith(marker[:n])), 0)


def complete(messages, max_tokens, thinking, emit):
    """One chat completion; emit(text) receives the answer while it is generated. Caller holds LOCK."""
    global _sink
    MODEL.set_config({"max_new_tokens": max_tokens, "jinja": {"context": {"enable_thinking": thinking}}})
    prompt = MODEL.apply_chat_template(messages)
    head = f"[MNNLLM] response: text={prompt}, stream=1, max_new_tokens=-1\n".encode()
    q = _sink = queue.Queue()
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    worker = threading.Thread(target=MODEL.response, args=(prompt, True), daemon=True)
    worker.start()
    raw, start, sent, idle, cancelled = b"", -1, 0, 0, False
    try:
        while worker.is_alive() or (not raw.endswith(TAIL) and idle < 20):
            try:
                raw += q.get(timeout=0.1)
            except queue.Empty:
                idle += not worker.is_alive()
                continue
            if start < 0:
                start = raw.find(head)
                if start < 0:
                    continue
                start += len(head)
            # Hold back what may be MNN's closing "\n" (end_with) or the start of TAIL.
            end = max(start + sent, len(raw) - max(_held(raw, b"\n" + TAIL), _held(raw, TAIL)))
            text = dec.decode(raw[start + sent:end])
            sent = end - start
            if text and not cancelled:
                try:
                    emit(text)
                except OSError:  # client went away: stop generating, keep draining
                    cancelled = True
                    MODEL._c_obj.set_context({"status": 3})  # LlmStatus.USER_CANCEL, checked every token
        worker.join()
        stopped = MODEL.stoped()  # stop token (vs. max_tokens); no string read, so always safe
        rest = raw[start + sent:].removesuffix(TAIL) if start >= 0 else b""
        if stopped:
            rest = rest.removesuffix(b"\n")
        text = dec.decode(rest, final=True)
        if text and not cancelled:
            emit(text)
    finally:
        _sink = None
    # generate_str may end mid character; clear it before reading the context. Reset the status so a
    # cancelled or failed request does not block the next one (MNN refuses to run after either).
    MODEL._c_obj.set_context({"generate_str": ""})
    ctx = MODEL._c_obj.get_context()
    MODEL._c_obj.set_context({"status": 0})
    if start < 0 or ctx["status"] == 4:  # LlmStatus.INTERNAL_ERROR
        raise RuntimeError("generation failed (see stderr)")
    usage = {"prompt_tokens": ctx["prompt_len"], "completion_tokens": ctx["gen_seq_len"],
             "total_tokens": ctx["prompt_len"] + ctx["gen_seq_len"]}
    STATE["requests"] += 1
    STATE["last_request"] = {**usage,
                             "prefill_tok_s": round(ctx["prompt_len"] / max(ctx["prefill_us"], 1) * 1e6, 1),
                             "decode_tok_s": round(ctx["gen_seq_len"] / max(ctx["decode_us"], 1) * 1e6, 1)}
    return ("stop" if stopped else "length"), usage


# ---------------------------------------------------------------- HTTP
class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def parse_request(body):
    """OpenAI chat request -> (messages, max_tokens, thinking, stream). Raises HTTPError(400)."""
    msgs = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(msgs, list) or not msgs:
        raise HTTPError(400, "messages must be a non-empty list")
    out = []
    for m in msgs:
        content = m.get("content") if isinstance(m, dict) else None
        if isinstance(content, list):  # [{"type": "text", "text": ...}, ...]
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        if not isinstance(content, str) or not isinstance(m.get("role"), str) or m["role"] not in ROLES:
            raise HTTPError(400, "each message needs a role (system, user, assistant) and text content")
        # MNN's binding crashes the process on text that is not valid UTF-8 (a lone "\ud800" from JSON),
        # and NUL would cut the prompt short in its C strings.
        content = content.encode("utf-8", "replace").decode().replace("\0", "")
        out.append({"role": ROLES[m["role"]], "content": content})
    try:
        max_tokens = int(body.get("max_completion_tokens") or body.get("max_tokens") or 2048)
    except (TypeError, ValueError):
        raise HTTPError(400, "max_tokens must be an integer")
    kwargs = body.get("chat_template_kwargs") or {}
    thinking = kwargs.get("enable_thinking", THINKING) is True if isinstance(kwargs, dict) else THINKING
    return out, max(1, min(max_tokens, MAX_TOKENS)), thinking, body.get("stream") is True


class Handler(BaseHTTPRequestHandler):
    server_version = "acurast-llm-mnn"
    sys_version = ""
    timeout = 120  # seconds a client may stall mid-request before its thread is freed

    def log_message(self, *args):  # no request logs on the phone
        pass

    def _send(self, status, obj=None, headers=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(status)
        # CORS only lets browsers make the request; it grants nothing without the key.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        # bytes: compare_digest raises on non-ASCII str
        if not hmac.compare_digest((self.headers.get("Authorization") or "").encode(), f"Bearer {API_KEY}".encode()):
            raise HTTPError(401, "invalid or missing bearer token")

    def _route(self, routes):
        try:
            fn = routes.get(self.path.split("?", 1)[0])
            if fn is None:
                raise HTTPError(404, "not found")
            fn()
        except HTTPError as e:
            self._send(e.status, {"error": {"message": str(e), "phase": STATE["phase"]}})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):  # CORS preflight
        self._send(204, headers={"Access-Control-Allow-Methods": "GET, POST",
                                 "Access-Control-Allow-Headers": "Authorization, Content-Type"})

    def do_GET(self):
        self._route({"/health": self.health, "/info": self.info, "/v1/models": self.models})

    def do_POST(self):
        self._route({"/v1/chat/completions": self.chat})

    def health(self):
        status = {"ready": "ok", "error": "error"}.get(STATE["phase"], "loading")
        self._send(200 if status == "ok" else 503, {"status": status, "phase": STATE["phase"]})

    def info(self):
        avail = next((l.split()[1] for l in _read("/proc/meminfo").splitlines() if l.startswith("MemAvailable")), "0")
        self._send(200, {**STATE, "ram_available_bytes": int(avail) * 1024, "busy": LOCK.locked()})

    def models(self):
        self._auth()
        self._send(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "taobao-mnn"}]})

    def chat(self):
        self._auth()
        if MODEL is None:
            raise HTTPError(503, "model not ready, see GET /info")
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY_BYTES:
            raise HTTPError(413 if length else 400, f"body must be JSON of at most {MAX_BODY_BYTES} bytes")
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            raise HTTPError(400, "body is not valid JSON")
        messages, max_tokens, thinking, stream = parse_request(body)
        cid, created = "chatcmpl-" + uuid.uuid4().hex, int(time.time())

        def chunk(delta, finish=None):
            obj = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": MODEL_ID,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")

        with LOCK:
            if not stream:
                parts = []
                try:
                    finish, usage = complete(messages, max_tokens, thinking, parts.append)
                except RuntimeError as e:
                    raise HTTPError(500, str(e))
                return self._send(200, {"id": cid, "object": "chat.completion", "created": created, "model": MODEL_ID,
                                        "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(parts)},
                                                     "finish_reason": finish}], "usage": usage})
            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()  # HTTP/1.0: the stream ends when the connection closes
            chunk({"role": "assistant", "content": ""})
            try:
                finish, _ = complete(messages, max_tokens, thinking, lambda t: chunk({"content": t}))
            except RuntimeError as e:
                self.wfile.write(b"data: " + json.dumps({"error": {"message": str(e)}}).encode() + b"\n\n")
                return
            chunk({}, finish)
            self.wfile.write(b"data: [DONE]\n\n")


def main():
    if not API_KEY:
        sys.exit("LLM_API_KEY is not set; refusing to serve the model without auth")
    allowed, speed, ratio = core_speeds()
    cores, threads = pick_threads(speed, ratio)
    # Before any thread starts: affinity is per thread on Linux, new threads inherit it.
    # An LLM_THREADS override leaves all cores to the scheduler.
    if cores and not os.environ.get("LLM_THREADS"):
        os.sched_setaffinity(0, cores)
    hw = next((l.split(":", 1)[1].strip() for l in _read("/proc/cpuinfo").splitlines() if l.startswith("Hardware")), None)
    mem = next((l.split()[1] for l in _read("/proc/meminfo").splitlines() if l.startswith("MemTotal")), "0")
    STATE["threads"] = int(os.environ.get("LLM_THREADS") or min(threads, len(allowed)))
    STATE["phone"] = {"chip": hw, "cores": len(allowed), "core_speeds": speed, "fast_cores": cores,
                      "ram_total_bytes": int(mem) * 1024}
    # Unbuffered C stdout into our pipe, before anything (MNN) prints to it. See complete().
    libc = ctypes.CDLL(None)
    libc.setvbuf(ctypes.c_void_p.in_dll(libc, "stdout"), None, 2, 0)  # 2 = _IONBF
    r, w = os.pipe()
    os.dup2(w, 1)
    os.close(w)
    sys.stdout = sys.stderr
    threading.Thread(target=_pump, args=(r,), daemon=True).start()
    threading.Thread(target=_prepare, daemon=True).start()
    log(f"listening on 127.0.0.1:{PORT}, model {REPO}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
