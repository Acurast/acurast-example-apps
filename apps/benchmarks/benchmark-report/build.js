#!/usr/bin/env node
// Reads data.json and writes a self-contained index.html with the data embedded
// (so it works over file://). Charts use Chart.js from a CDN (needs internet to
// render, but the data is local). N-environment aware (nodejs / cargo /
// cargo-native, and any future environment that posts the same shape).
//
// Usage:
//   node build.js          -> index.html (all reports)
//   node build.js all3     -> index-all3.html (only devices with all 3 runtimes)

const fs = require("fs");
const path = require("path");

let data = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));

// Canonicalize device addresses. cargo-rust (and fixed cargo) report both an
// SS58 deviceAddress and the p256 deviceKey; older cargo reports have a bogus
// deviceAddress ("processors") but a valid deviceKey. Build deviceKey -> SS58
// from the reports that have both, then backfill so every report groups under
// its real SS58 address.
const isSS58 = (k) => /^[1-9A-HJ-NP-Za-km-z]{46,49}$/.test(k || "");
const keyToAddr = {};
for (const r of data) {
  if (r.deviceKey && isSS58(r.deviceAddress)) keyToAddr[r.deviceKey.toLowerCase()] = r.deviceAddress;
}
for (const r of data) {
  if (!isSS58(r.deviceAddress) && r.deviceKey && keyToAddr[r.deviceKey.toLowerCase()]) {
    r.deviceAddress = keyToAddr[r.deviceKey.toLowerCase()];
  }
}

// Optional "all3" mode: keep only devices that ran every environment present.
const ALL3 = process.argv.includes("all3");
let all3Count = 0;
if (ALL3) {
  const allEnvs = [...new Set(data.map((r) => r.environment))];
  const byDev = {};
  for (const r of data) (byDev[r.deviceAddress] = byDev[r.deviceAddress] || new Set()).add(r.environment);
  const complete = new Set(
    Object.entries(byDev).filter(([, s]) => allEnvs.every((e) => s.has(e))).map(([a]) => a)
  );
  data = data.filter((r) => complete.has(r.deviceAddress));
  all3Count = complete.size;
  console.log(`all3 mode: ${complete.size} devices ran all ${allEnvs.length} runtimes -> ${data.length} reports`);
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Acurast Benchmark — node vs cargo-node vs cargo-rust</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3;
    --muted: #8b949e; --accent: #58a6ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  header { padding: 20px 24px; border-bottom: 1px solid var(--border); }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: var(--muted); font-size: 13px; }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: end;
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 24px; }
  .filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .filters select { background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 8px; font-size: 13px; min-width: 130px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 12px; margin-bottom: 24px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 2px; }
  .card .v small { font-size: 13px; color: var(--muted); font-weight: 400; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  @media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .panel h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  .panel .hint { color: var(--muted); font-size: 12px; margin: -6px 0 12px; }
  .matrices { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: right; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--panel); }
  th:first-child, td:first-child { text-align: left; }
  .tablewrap { max-height: 420px; overflow: auto; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>Acurast Benchmark Overview</h1>
  <div class="sub">Same workload across runtimes. <b style="color:#3fb950">node</b> = native Acurast runtime (JS). <b style="color:#d29922">cargo-node</b> = Node inside proot. <b style="color:#bc8cff">cargo-rust</b> = compiled Rust inside proot. All times in seconds (lower is better).</div>
  <div id="ipnote" style="margin-top:10px;font-size:12px;color:var(--muted);background:rgba(88,166,255,.08);border:1px solid var(--border);border-radius:6px;padding:8px 12px"></div>
</header>
<main>
  <div class="filters">
    <label>Environment <select id="f-env"></select></label>
    <label>Arch <select id="f-arch"></select></label>
    <label>Node <select id="f-node"></select></label>
    <label>Memory <select id="f-mem"></select></label>
    <label>Aggregate <select id="f-agg"><option value="median">median</option><option value="mean">average</option><option value="p90">p90 (slowest 10%)</option></select></label>
    <label>&nbsp;<button id="f-reset" style="background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:6px 12px;cursor:pointer">Reset</button></label>
  </div>

  <div class="cards" id="cards"></div>

  <div class="grid2">
    <div class="panel"><h2>Time per section, per environment</h2><div class="hint" id="agg-label"></div><canvas id="c-sections"></canvas></div>
    <div class="panel"><h2>Ratio per section vs nodejs</h2><div class="hint">&gt;1 = slower than the native nodejs runtime.</div><canvas id="c-ratio"></canvas></div>
  </div>

  <div class="grid2">
    <div class="panel"><h2>Distribution of total time</h2><div class="hint">Histogram, bucketed (seconds).</div><canvas id="c-hist"></canvas></div>
    <div class="panel"><h2>proot bootstrap: setup &amp; build</h2><div class="hint">One-time proot costs (seconds): setup = toolchain/node install; build = Rust compile (cargo-native only).</div><canvas id="c-setup"></canvas></div>
  </div>

  <div class="grid2">
    <div class="panel"><h2>Network throughput</h2><div class="hint">Median Mbit/s downloading 10&nbsp;MB — higher is better. (node via fetch; cargo via curl.)</div><canvas id="c-net-tp"></canvas></div>
    <div class="panel"><h2>Network: 20 parallel requests</h2><div class="hint">Median wall time (s) to complete 20 concurrent 100&nbsp;KB downloads — lower is better.</div><canvas id="c-net-par"></canvas></div>
  </div>

  <div class="panel" style="margin-bottom:24px">
    <h2>Within-device consistency</h2>
    <div class="hint">For devices that ran the benchmark more than once: how much does the same device vary between runs? CV = stddev/mean of total time. Low CV = the spread across the fleet is real hardware difference, not noise.</div>
    <div id="consistency"></div>
  </div>

  <div class="panel">
    <h2>Reports (<span id="tcount"></span>)</h2>
    <div class="hint">Click a column header to sort.</div>
    <div class="tablewrap"><table id="table"></table></div>
  </div>
</main>

<script>
const DATA = __DATA__;
const SECTIONS = [
  ["cpu_primes_ms", "CPU primes"],
  ["crypto_sha256_ms", "sha256"],
  ["json_ms", "JSON"],
  ["file_io_ms", "File IO"],
  ["mem_ms", "Memory"],
];
// Known environments, in display order, with colors. Only those present in the
// data are shown. nodejs is the ratio baseline.
const ENV_DEFS = [
  { key: "nodejs", color: "#3fb950" },
  { key: "cargo", color: "#d29922" },
  { key: "cargo-native", color: "#bc8cff" },
];
const BASELINE = "nodejs";
const present = new Set(DATA.map(d => d.environment));
const ENVS = ENV_DEFS.filter(e => present.has(e.key));
// any environment in the data not in ENV_DEFS gets a fallback color
DATA.map(d=>d.environment).forEach(k=>{ if(!ENV_DEFS.some(e=>e.key===k)) ENVS.push({key:k,color:"#8b949e"}); });
const COL = Object.fromEntries(ENVS.map(e => [e.key, e.color]));
const ENV_KEYS = ENVS.map(e => e.key);
// Display labels (data keys stay as-is for filtering/download).
const LABEL = { nodejs: "node", cargo: "cargo-node", "cargo-native": "cargo-rust" };
const lbl = (e) => LABEL[e] || e;

const GB = (b) => b ? (b / 1024 / 1024 / 1024).toFixed(1) : null;
const S = (ms) => (ms == null || isNaN(ms)) ? null : ms / 1000; // ms -> seconds
// Prefer the SS58 address (node: deviceAddress, cargo: processorAddress) so the
// same physical device links across runtimes; fall back to the p256 deviceKey.
const deviceId = (r) => r.deviceAddress || r.processorAddress || r.deviceKey || null;
const distinct = (rows) => new Set(rows.map(deviceId).filter(Boolean)).size;

function median(xs){ if(!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function mean(xs){ return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN; }
function p90(xs){ if(!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(0.9*s.length))]; }
const AGG = { median, mean, p90 };
function stddev(xs){ const m=mean(xs); return Math.sqrt(mean(xs.map(x=>(x-m)**2))); }
function cv(xs){ return xs.length>1 ? stddev(xs)/mean(xs) : null; } // coefficient of variation
const val=(id)=>document.getElementById(id).value;

function fill(id, values, fmt=(v)=>v){
  const el = document.getElementById(id);
  const uniq = [...new Set(values.filter(v=>v!=null))].sort((a,b)=> (typeof a==="number"? a-b : String(a).localeCompare(String(b))));
  el.innerHTML = '<option value="">all</option>' + uniq.map(v=>'<option value="'+v+'">'+fmt(v)+'</option>').join("");
}
document.getElementById("f-env").innerHTML='<option value="">all</option>'+ENV_KEYS.map(e=>'<option value="'+e+'">'+lbl(e)+'</option>').join("");
fill("f-arch", DATA.map(d=>d.arch));
fill("f-node", DATA.map(d=>d.node_version));
fill("f-mem", DATA.map(d=>GB(d.total_mem_bytes)), v=>v+" GB");

function filtered(){
  const env=val("f-env"), arch=val("f-arch"), node=val("f-node"), mem=val("f-mem");
  return DATA.filter(d =>
    (!env || d.environment===env) &&
    (!arch || d.arch===arch) &&
    (!node || d.node_version===node) &&
    (!mem || GB(d.total_mem_bytes)===mem)
  );
}

const VARS = [
  ["cpu_primes_ms","CPU"], ["crypto_sha256_ms","sha256"], ["json_ms","JSON"],
  ["file_io_ms","FileIO"], ["mem_ms","Mem"], ["total_ms","total"],
  ["mem_gb","RAM"], ["setup_ms","setup"], ["build_ms","build"],
];
function getVar(r, key){
  if (key==="mem_gb") return r.total_mem_bytes ? r.total_mem_bytes/1e9 : null;
  if (key==="setup_ms") return S(r.setup_ms);
  if (key==="build_ms") return S(r.build_ms);
  if (key==="total_ms") return S(r.total_ms);
  return r.results_ms ? S(r.results_ms[key]) : null;
}
function pearson(xs, ys){
  const pairs = xs.map((x,i)=>[x,ys[i]]).filter(([a,b])=>typeof a==="number"&&typeof b==="number"&&!isNaN(a)&&!isNaN(b));
  const n=pairs.length; if(n<3) return null;
  const mx=pairs.reduce((s,p)=>s+p[0],0)/n, my=pairs.reduce((s,p)=>s+p[1],0)/n;
  let num=0,dx=0,dy=0;
  for(const [a,b] of pairs){ num+=(a-mx)*(b-my); dx+=(a-mx)**2; dy+=(b-my)**2; }
  return (dx&&dy) ? num/Math.sqrt(dx*dy) : null;
}

let charts={};
function chart(id, cfg){ if(charts[id]) charts[id].destroy(); charts[id]=new Chart(document.getElementById(id), cfg); }
function baseOpts(unit){ return { responsive:true,
  plugins:{ legend:{labels:{color:"#e6edf3"}}, tooltip:{callbacks:{label:(c)=>c.dataset.label+": "+c.parsed.y+" "+unit}} },
  scales:{ x:axis(), y:{...axis(), beginAtZero:true} } }; }
function axis(){ return { ticks:{color:"#8b949e"}, grid:{color:"#21262d"} }; }

// General histogram over N series sharing the same bins.
function histChart(id, series, yTitle){
  const all=series.flatMap(s=>s.vals).filter(v=>v!=null&&!isNaN(v));
  if(!all.length){ chart(id,{type:"bar",data:{labels:[],datasets:[]},options:baseOpts("count")}); return; }
  const min=Math.min(...all), max=Math.max(...all), bins=12, w=(max-min)/bins||1;
  const labels=Array.from({length:bins},(_,i)=>(min+i*w).toFixed(1));
  const datasets=series.filter(s=>s.vals.some(v=>v!=null)).map(s=>{
    const counts=new Array(bins).fill(0);
    s.vals.filter(v=>v!=null&&!isNaN(v)).forEach(v=>{ let b=Math.floor((v-min)/w); if(b>=bins)b=bins-1; if(b<0)b=0; counts[b]++; });
    return { label:s.label, backgroundColor:s.color, data:counts };
  });
  chart(id,{type:"bar",data:{labels,datasets},options:{...baseOpts("count"),plugins:{legend:{display:datasets.length>1,labels:{color:"#e6edf3"}}},scales:{x:axis(),y:{...axis(),beginAtZero:true,title:{display:true,text:yTitle,color:"#8b949e"}}}}});
}

function render(){
  const rows = filtered();
  const agg = AGG[val("f-agg")] || median;
  const byEnv = Object.fromEntries(ENV_KEYS.map(e => [e, rows.filter(r=>r.environment===e)]));
  document.getElementById("agg-label").textContent = val("f-agg") + " of " + rows.length + " report(s)";

  const aggTotal = (e)=> byEnv[e].length ? agg(byEnv[e].map(r=>r.total_ms)) : NaN;
  const totals = Object.fromEntries(ENV_KEYS.map(e=>[e, aggTotal(e)]));
  const base = totals[BASELINE];

  // network metric helpers (network may be absent on old reports)
  const netVals = (e, f) => byEnv[e].map(r=>r.network && r.network[f]!=null ? r.network[f] : null).filter(v=>v!=null);
  const netAgg = (e, f) => { const v=netVals(e,f); return v.length ? agg(v) : null; };

  // Cards (dynamic over environments)
  const cards = [
    ["reports", rows.length + " <small>(" + ENV_KEYS.map(e=>byEnv[e].length+" "+lbl(e)).join(" / ") + ")</small>"],
    ["distinct devices", ENV_KEYS.map(e=>(distinct(byEnv[e])||"—")+" <small>"+lbl(e)+"</small>").join(" / ")],
  ];
  ENV_KEYS.forEach(e=> cards.push([lbl(e)+" total", isNaN(totals[e])?"—":S(totals[e]).toFixed(2)+" <small>s</small>"]));
  ENV_KEYS.filter(e=>e!==BASELINE).forEach(e=>{
    const r=(base&&totals[e])?(totals[e]/base):NaN;
    cards.push([lbl(e)+" / "+lbl(BASELINE), isNaN(r)?"—":r.toFixed(2)+"×"]);
  });
  // network medians per env
  const netTxt = ENV_KEYS.map(e=>{ const v=netAgg(e,"throughput_mbps"); return v==null?null:lbl(e)+" "+v.toFixed(0); }).filter(Boolean).join(" / ");
  if(netTxt) cards.push(["network <small>Mbps ↑</small>", "<span style='font-size:15px'>"+netTxt+"</span>"]);
  // setup + build (proot-only costs)
  const setupTxt = ENV_KEYS.map(e=>{ const v=byEnv[e].map(r=>r.setup_ms).filter(x=>x!=null); return v.length?lbl(e)+" "+S(agg(v)).toFixed(1)+"s":null; }).filter(Boolean).join(" / ");
  if(setupTxt) cards.push(["setup", "<span style='font-size:15px'>"+setupTxt+"</span>"]);
  const buildVals = rows.map(r=>r.build_ms).filter(v=>v!=null);
  if(buildVals.length) cards.push(["build <small>(cargo-rust)</small>", S(agg(buildVals)).toFixed(1)+" <small>s</small>"]);
  card("cards", cards);

  // Sections grouped bar — one dataset per environment
  const labels = SECTIONS.map(s=>s[1]);
  chart("c-sections", { type:"bar",
    data:{ labels, datasets: ENV_KEYS.map(e=>({
      label:lbl(e), backgroundColor:COL[e],
      data: SECTIONS.map(([k])=> byEnv[e].length ? +S(agg(byEnv[e].map(r=>r.results_ms[k]))).toFixed(2) : null)
    }))},
    options: baseOpts("s") });

  // Ratio per section vs baseline — one dataset per non-baseline environment
  const sAgg = (e,k)=> byEnv[e].length ? agg(byEnv[e].map(r=>r.results_ms[k])) : NaN;
  chart("c-ratio", { type:"bar",
    data:{ labels, datasets: ENV_KEYS.filter(e=>e!==BASELINE).map(e=>({
      label: lbl(e)+"/"+lbl(BASELINE), backgroundColor: COL[e],
      data: SECTIONS.map(([k])=>{ const b=sAgg(BASELINE,k), v=sAgg(e,k); return (b&&v)? +(v/b).toFixed(2) : null; })
    }))},
    options: { ...baseOpts("×"), scales:{ x:axis(), y:{...axis(), suggestedMin:0, grid:{color:"#30363d"}} } } });

  // total distribution histogram — per environment
  histChart("c-hist", ENV_KEYS.map(e=>({label:lbl(e), color:COL[e], vals:byEnv[e].map(r=>S(r.total_ms))})), "# reports");

  // setup + build histogram — per environment (only those with values)
  const setupSeries = ENV_KEYS.map(e=>({label:lbl(e)+" setup", color:COL[e], vals:byEnv[e].map(r=>S(r.setup_ms))}))
    .concat([{label:"cargo-rust build", color:"#58a6ff", vals:(byEnv["cargo-native"]||[]).map(r=>S(r.build_ms))}]);
  histChart("c-setup", setupSeries, "# reports");

  // network: throughput (Mbps, higher better) + 20-parallel time (s, lower better)
  chart("c-net-tp", { type:"bar",
    data:{ labels:["throughput"], datasets: ENV_KEYS.map(e=>({ label:lbl(e), backgroundColor:COL[e], data:[netAgg(e,"throughput_mbps")] }))},
    options: baseOpts("Mbps") });
  chart("c-net-par", { type:"bar",
    data:{ labels:["20 parallel"], datasets: ENV_KEYS.map(e=>({ label:lbl(e), backgroundColor:COL[e], data:[(()=>{const v=netAgg(e,"parallel_ms"); return v==null?null:+(v/1000).toFixed(2);})()] }))},
    options: baseOpts("s") });

  consistency(byEnv);
  buildTable(rows);
}

// Within-device variation: for devices with ≥2 runs, how consistent is total_ms?
function consistency(byEnv){
  const el=document.getElementById("consistency");
  const blocks=ENV_KEYS.map(e=>{
    const byDev={};
    byEnv[e].forEach(r=>{const k=deviceId(r); if(k)(byDev[k]=byDev[k]||[]).push(r);});
    const keyed=Object.keys(byDev).length;
    const reused=Object.entries(byDev).filter(([,rs])=>rs.length>=2);
    if(!reused.length) return '<div style="margin-bottom:8px"><b style="color:'+COL[e]+'">'+lbl(e)+'</b>: '+keyed+' device(s), none ran ≥2×</div>';
    const cvs=reused.map(([,rs])=>cv(rs.map(r=>r.total_ms))).filter(x=>x!=null).sort((a,b)=>a-b);
    const pct=p=>cvs[Math.min(cvs.length-1,Math.floor(p*cvs.length))];
    const ex=reused.sort((a,b)=>b[1].length-a[1].length).slice(0,5).map(([dev,rs])=>{
      const t=rs.map(r=>S(r.total_ms)).sort((a,b)=>a-b).map(v=>v.toFixed(1));
      return '<tr><td><code>'+dev.slice(0,10)+'…</code></td><td>'+rs.length+'</td><td>['+t.join(", ")+'] s</td><td>'+(cv(rs.map(r=>r.total_ms))*100).toFixed(1)+'%</td></tr>';
    }).join("");
    return '<div style="margin-bottom:16px"><b style="color:'+COL[e]+'">'+lbl(e)+'</b>: '+reused.length+'/'+keyed+
      ' devices ran ≥2× — total CV median <b>'+(pct(.5)*100).toFixed(1)+'%</b>, p90 '+(pct(.9)*100).toFixed(1)+'%, max '+(Math.max(...cvs)*100).toFixed(1)+'%'+
      '<table style="font-size:11px;margin-top:6px"><tr><th style="text-align:left">device</th><th>runs</th><th style="text-align:left">total times (sorted)</th><th>CV</th></tr>'+ex+'</table></div>';
  });
  el.innerHTML=blocks.join("");
}

function matrix(id, rows){
  const el=document.getElementById(id);
  if(!el) return;
  if(rows.length<3){ el.innerHTML='<div style="color:var(--muted);font-size:12px">need ≥3 reports</div>'; return; }
  const vars=VARS.filter(([k])=> rows.some(r=>typeof getVar(r,k)==="number"));
  const head="<tr><th></th>"+vars.map(([,l])=>'<th style="text-align:center">'+l+'</th>').join("")+"</tr>";
  const body=vars.map(([ka,la])=>{
    const cells=vars.map(([kb])=>{
      const r=pearson(rows.map(x=>getVar(x,ka)), rows.map(x=>getVar(x,kb)));
      if(r==null) return '<td style="text-align:center;color:var(--muted)">·</td>';
      const hue=r>=0?140:0, a=Math.min(Math.abs(r),1)*0.85;
      const fg=Math.abs(r)>0.55?"#fff":"var(--fg)";
      return '<td style="text-align:center;background:hsla('+hue+',70%,40%,'+a.toFixed(2)+');color:'+fg+'">'+r.toFixed(2)+'</td>';
    }).join("");
    return "<tr><th style='text-align:left'>"+la+"</th>"+cells+"</tr>";
  }).join("");
  el.innerHTML='<table style="font-size:11px">'+head+body+'</table>';
}

function card(id, items){ document.getElementById(id).innerHTML = items.map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join(""); }

let sortKey="total_ms", sortDir=1;
function buildTable(rows){
  document.getElementById("tcount").textContent = rows.length;
  const cols=[["environment","env"],["arch","arch"],["total_mem_bytes","mem(GB)"],["node_version","node"],["ip","ip"],
    ...SECTIONS.map(([k,l])=>[k,l+" (s)"]),["total_ms","total (s)"],["setup_ms","setup (s)"],["build_ms","build (s)"],["net_mbps","net Mbps"],["net_parallel_ms","20-par (s)"],["device","device"]];
  const sorted=[...rows].sort((a,b)=>{ const va=cell(a,sortKey),vb=cell(b,sortKey);
    if(typeof va==="number"&&typeof vb==="number") return (va-vb)*sortDir;
    return String(va).localeCompare(String(vb))*sortDir; });
  const head="<tr>"+cols.map(([k,l])=>'<th data-k="'+k+'">'+l+(sortKey===k?(sortDir>0?" ▲":" ▼"):"")+'</th>').join("")+"</tr>";
  const body=sorted.map(r=>"<tr>"+cols.map(([k])=>"<td>"+fmtCell(r,k)+"</td>").join("")+"</tr>").join("");
  const t=document.getElementById("table"); t.innerHTML=head+body;
  t.querySelectorAll("th").forEach(th=>th.onclick=()=>{ const k=th.dataset.k; if(sortKey===k)sortDir*=-1; else {sortKey=k;sortDir=1;} buildTable(rows); });
}
const netf = (r,f) => (r.network && r.network[f]!=null ? r.network[f] : null);
function cell(r,k){ if(k==="total_mem_bytes") return +GB(r.total_mem_bytes)||0; if(k==="device") return deviceId(r)||""; if(k==="net_mbps") return netf(r,"throughput_mbps")||0; if(k==="net_parallel_ms") return netf(r,"parallel_ms")||0; if(SECTIONS.some(s=>s[0]===k)) return r.results_ms[k]; return r[k]; }
function fmtCell(r,k){
  if(k==="environment") return '<span class="pill" style="background:'+(COL[r.environment]||"#8b949e")+'22;color:'+(COL[r.environment]||"#8b949e")+'">'+lbl(r.environment)+'</span>';
  if(k==="total_mem_bytes") return GB(r.total_mem_bytes)||"—";
  if(k==="device"){ const id=deviceId(r); return id?('<code>'+id.slice(0,10)+'…</code>'):"—"; }
  if(k==="net_mbps"){ const v=netf(r,"throughput_mbps"); return v!=null?v.toFixed(0):"—"; }
  if(k==="net_parallel_ms"){ const v=netf(r,"parallel_ms"); return v!=null?(v/1000).toFixed(2):"—"; }
  if(k==="setup_ms") return r.setup_ms!=null?S(r.setup_ms).toFixed(2):"—";
  if(k==="build_ms") return r.build_ms!=null?S(r.build_ms).toFixed(2):"—";
  if(SECTIONS.some(s=>s[0]===k)){ const v=r.results_ms[k]; return v!=null?S(v).toFixed(2):"—"; }
  if(k==="total_ms") return S(r.total_ms).toFixed(2);
  return r[k]==null?"—":r[k];
}

// IP-is-not-a-device caveat, computed live from the nodejs side (which has both
// a device address AND an IP), so the proof is in the data itself.
(function(){
  const nj=DATA.filter(d=>d.environment==="nodejs");
  if(!nj.length){ document.getElementById("ipnote").innerHTML="<b>Note:</b> device identity comes from deviceAddress (node) or deviceKey (cargo-node / cargo-rust). IP is not a device id (NAT)."; return; }
  const ipToDev={}; nj.forEach(r=>{ (ipToDev[r.ip]=ipToDev[r.ip]||new Set()).add(r.deviceAddress); });
  const sharedIps=Object.values(ipToDev).filter(s=>s.size>1).length;
  const proot=DATA.filter(d=>d.environment==="cargo"||d.environment==="cargo-native");
  const keyed=proot.filter(r=>r.deviceKey).length;
  document.getElementById("ipnote").innerHTML =
    "<b>Why device ≠ IP:</b> the "+nj.length+" node reports come from <b>"+distinct(nj)+
    " distinct devices</b> but only "+new Set(nj.map(r=>r.ip)).size+" distinct IPs — <b>"+sharedIps+
    " IP(s) are shared by multiple devices</b> (NAT), so IP cannot identify a device. "+
    "proot reports (cargo-node / cargo-rust) carry a p256 <code>deviceKey</code> ("+keyed+"/"+proot.length+
    " have one) for per-device dedup. deviceKey (p256) and deviceAddress (SS58) are different key types, so they don't cross-link between runtimes.";
})();

["f-env","f-arch","f-node","f-mem","f-agg"].forEach(id=>document.getElementById(id).addEventListener("change",render));
document.getElementById("f-reset").onclick=()=>{ ["f-env","f-arch","f-node","f-mem"].forEach(id=>document.getElementById(id).value=""); document.getElementById("f-agg").value="median"; render(); };
render();
</script>
</body>
</html>`;

let finalHtml = html.replace("__DATA__", JSON.stringify(data));
if (ALL3) {
  finalHtml = finalHtml.replace(
    "All times in seconds (lower is better).",
    `All times in seconds (lower is better). <b style="color:var(--accent)">Apples-to-apples: only the ${all3Count} devices that ran all three runtimes.</b>`
  );
}
const out = path.join(__dirname, ALL3 ? "index-all3.html" : "index.html");
fs.writeFileSync(out, finalHtml);
console.log(`Wrote ${out} (${data.length} reports embedded)`);
