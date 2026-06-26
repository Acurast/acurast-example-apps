#!/usr/bin/env python3
"""Tiny, INSECURE web SQL console for the Cargo Postgres deployment.

Serves a single-page UI plus a JSON `/api/query` endpoint that shells out to
`psql` against the local Postgres (trust auth over the unix socket). There is
NO authentication and NO query restriction whatsoever — anyone who can reach
the tunnel URL can run arbitrary SQL. It exists so you can poke at a disposable
database from a browser; do not put anything sensitive behind it.
"""

import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WEB_PORT = int(os.environ.get("WEB_PORT", "8080"))
PGSOCKET = os.environ.get("PGSOCKET", "/tmp/pgsocket")
PGPORT = os.environ.get("PGPORT", "5432")
POSTGRES_USER = os.environ.get("POSTGRES_USER", "postgres")
POSTGRES_DB = os.environ.get("POSTGRES_DB", "postgres")

# Field / record separators unlikely to appear in data, so multi-line and
# comma-containing values survive the round trip unmangled.
FS = "\x1f"
RS = "\x1e"

PSQL_BIN = None


def find_psql():
    global PSQL_BIN
    if PSQL_BIN:
        return PSQL_BIN
    for base in sorted(_glob_psql(), reverse=True):
        PSQL_BIN = base
        return base
    PSQL_BIN = "psql"
    return PSQL_BIN


def _glob_psql():
    import glob

    return glob.glob("/usr/lib/postgresql/*/bin/psql")


def run_sql(sql):
    """Run SQL via psql, return (columns, rows, message, error)."""
    cmd = [
        find_psql(),
        "-X",
        "-A",
        "-F", FS,
        "-R", RS,
        "-P", "footer=off",
        "-v", "ON_ERROR_STOP=1",
        "-h", PGSOCKET,
        "-p", str(PGPORT),
        "-U", POSTGRES_USER,
        "-d", POSTGRES_DB,
        "-c", sql,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            # Connect over the trust unix socket as the postgres OS user.
            env={**os.environ, "PGOPTIONS": ""},
        )
    except subprocess.TimeoutExpired:
        return None, None, None, "Query timed out after 60s"

    out = proc.stdout
    err = proc.stderr.strip()

    if proc.returncode != 0:
        return None, None, None, err or "psql failed"

    # Tabular output contains the field separator; a bare command tag
    # (e.g. "INSERT 0 1", "CREATE TABLE") does not.
    if FS in out:
        records = [r for r in out.split(RS) if r != ""]
        if not records:
            return [], [], err or None, None
        columns = records[0].split(FS)
        rows = [r.split(FS) for r in records[1:]]
        return columns, rows, err or None, None

    message = out.replace(RS, "\n").strip()
    return None, None, message or err or "OK", None


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Postgres Console (insecure)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0f1117; color: #e6e6e6;
  }
  .warn {
    background: #5a1d1d; color: #ffd9d9; padding: 10px 16px;
    border-bottom: 1px solid #7a2a2a; font-weight: 600;
  }
  .wrap { display: grid; grid-template-columns: 240px 1fr; height: calc(100vh - 41px); }
  aside {
    border-right: 1px solid #222631; padding: 12px; overflow: auto; background: #11131b;
  }
  aside h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #8b93a7; margin: 0 0 8px; }
  aside ul { list-style: none; margin: 0; padding: 0; }
  aside li { padding: 4px 6px; border-radius: 4px; cursor: pointer; color: #cdd3e0; }
  aside li:hover { background: #1c2030; }
  main { display: flex; flex-direction: column; min-width: 0; padding: 12px; gap: 10px; }
  textarea {
    width: 100%; height: 140px; resize: vertical; background: #11131b; color: #e6e6e6;
    border: 1px solid #2a2f3d; border-radius: 6px; padding: 10px; font: inherit;
  }
  .bar { display: flex; gap: 8px; align-items: center; }
  button {
    background: #3b6ea5; color: #fff; border: 0; border-radius: 6px;
    padding: 8px 16px; cursor: pointer; font: inherit; font-weight: 600;
  }
  button:hover { background: #4a82c0; }
  .hint { color: #8b93a7; }
  .out { flex: 1; overflow: auto; border: 1px solid #222631; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #222631; padding: 5px 9px; text-align: left; white-space: pre-wrap; vertical-align: top; }
  th { background: #1a1e2a; position: sticky; top: 0; }
  tr:nth-child(even) td { background: #13161f; }
  .msg { padding: 12px; }
  .err { padding: 12px; color: #ff9a9a; white-space: pre-wrap; }
  .null { color: #6b7280; font-style: italic; }
</style>
</head>
<body>
  <div class="warn">⚠ Insecure SQL console — no authentication, runs arbitrary SQL. Disposable databases only. Do not store anything sensitive.</div>
  <div class="wrap">
    <aside>
      <h2>Tables</h2>
      <ul id="tables"><li class="hint">loading…</li></ul>
    </aside>
    <main>
      <textarea id="sql" placeholder="SELECT * FROM pg_catalog.pg_tables LIMIT 10;" spellcheck="false"></textarea>
      <div class="bar">
        <button id="run">Run (Ctrl+Enter)</button>
        <span class="hint">db: <b id="dbname"></b></span>
      </div>
      <div class="out" id="out"><div class="msg hint">Results appear here.</div></div>
    </main>
  </div>
<script>
const $ = (id) => document.getElementById(id);
const out = $("out");

async function query(sql) {
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  return res.json();
}

function renderCell(v) {
  if (v === null) return '<span class="null">NULL</span>';
  const d = document.createElement("div");
  d.textContent = v;
  return d.innerHTML;
}

function render(r) {
  if (r.error) { out.innerHTML = '<div class="err">' + renderCell(r.error) + '</div>'; return; }
  if (r.columns) {
    let h = "<table><thead><tr>";
    for (const c of r.columns) h += "<th>" + renderCell(c) + "</th>";
    h += "</tr></thead><tbody>";
    for (const row of r.rows) {
      h += "<tr>";
      for (const cell of row) h += "<td>" + renderCell(cell) + "</td>";
      h += "</tr>";
    }
    h += "</tbody></table>";
    if (r.rows.length === 0) h += '<div class="msg hint">0 rows</div>';
    out.innerHTML = h;
  } else {
    out.innerHTML = '<div class="msg">' + renderCell(r.message || "OK") + "</div>";
  }
}

async function run() {
  const sql = $("sql").value.trim();
  if (!sql) return;
  out.innerHTML = '<div class="msg hint">running…</div>';
  try { render(await query(sql)); }
  catch (e) { out.innerHTML = '<div class="err">' + e + "</div>"; }
}

async function loadTables() {
  const r = await query(
    "SELECT schemaname || '.' || tablename AS t FROM pg_catalog.pg_tables " +
    "WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1;"
  );
  const ul = $("tables");
  if (r.error || !r.rows || r.rows.length === 0) {
    ul.innerHTML = '<li class="hint">no user tables</li>';
    return;
  }
  ul.innerHTML = "";
  for (const [name] of r.rows) {
    const li = document.createElement("li");
    li.textContent = name;
    li.onclick = () => { $("sql").value = "SELECT * FROM " + name + " LIMIT 100;"; run(); };
    ul.appendChild(li);
  }
}

$("run").onclick = run;
$("sql").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
});
$("dbname").textContent = "%DBNAME%";
loadTables();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(200, INDEX_HTML.replace("%DBNAME%", POSTGRES_DB), "text/html; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path != "/api/query":
            self._send(404, "not found", "text/plain")
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            sql = (payload.get("sql") or "").strip()
        except Exception as e:
            self._send(400, json.dumps({"error": f"bad request: {e}"}), "application/json")
            return
        if not sql:
            self._send(400, json.dumps({"error": "empty query"}), "application/json")
            return

        columns, rows, message, error = run_sql(sql)
        resp = {"error": error} if error else {
            "columns": columns,
            "rows": rows,
            "message": message,
        }
        self._send(200, json.dumps(resp), "application/json")

    def log_message(self, fmt, *args):
        # Quieter logs; the tunnel/start.sh output is the interesting part.
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", WEB_PORT), Handler)
    print(f"Web SQL console listening on 127.0.0.1:{WEB_PORT} (db={POSTGRES_DB})")
    server.serve_forever()


if __name__ == "__main__":
    main()
