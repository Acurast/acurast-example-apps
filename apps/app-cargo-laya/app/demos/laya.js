// Shared by the demo pages: the deployment URL + API key (remembered in this
// browser's localStorage, same keys the snake page uses; defaults from config.js)
// and one Laya call.
const Laya = (() => {
  // Saved value, else the local defaults from config.js (if present).
  const DEFAULTS = { 'laya-url': (window.LAYA_DEFAULTS || {}).url || '', 'laya-key': (window.LAYA_DEFAULTS || {}).key || '' };
  // A saved value only wins while config.js still has the default it was saved
  // against; after a redeploy updates config.js, the new default applies again.
  const load = k => {
    try {
      const v = localStorage.getItem(k);
      if (v && localStorage.getItem(k + ':default') === DEFAULTS[k]) return v;
    } catch (e) {}
    return DEFAULTS[k] || '';
  };
  const save = (k, v) => { try { localStorage.setItem(k, v); localStorage.setItem(k + ':default', DEFAULTS[k]); } catch (e) {} };

  // Current deployment settings, for pages that call the API themselves.
  const config = () => ({ url: load('laya-url').replace(/\/+$/, ''), key: load('laya-key') });

  // Settings panel behind the gear in the header: URL + key, saved on input.
  function settingsPanel() {
    const d = document.createElement('dialog');
    d.className = 'acu-settings';
    d.innerHTML = `<form method="dialog">
      <h3>Settings</h3>
      <label>Deployment URL<input data-k="laya-url" placeholder="https://&lt;id&gt;.acu.run"></label>
      <label>API key (LAYA_API_KEY)<input data-k="laya-key" type="password"></label>
      <p class="muted">Prefilled from config.js. Saved in this browser, shared by all demos.</p>
      <div class="row"><button type="button" data-test>Test connection</button><span data-status class="muted"></span>
        <span class="spacer"></span><button>Close</button></div>
    </form>`;
    d.querySelectorAll('input').forEach(i => {
      i.value = load(i.dataset.k);
      i.oninput = () => save(i.dataset.k, i.value.trim());
    });
    const status = d.querySelector('[data-status]');
    d.querySelector('[data-test]').onclick = async () => {
      const { url, key } = config();
      status.textContent = 'checking...';
      try {
        const h = await (await fetch(url + '/health')).json();
        const auth = await fetch(url + '/v1/systemone', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: '{}' });
        status.textContent = auth.status === 401 ? 'reachable, but the key is wrong' : `connected · model ${h.loaded.join(', ')}`;
      } catch (e) { status.textContent = 'not reachable: ' + e.message; }
    };
    d.onclick = e => { if (e.target === d) d.close(); }; // click outside closes
    document.body.appendChild(d);
    return d;
  }

  // POST /v1/systemone. `questions` is Laya's typed-question object.
  // Returns { answers, ms }.
  async function ask(state, questions) {
    const url = load('laya-url').replace(/\/+$/, ''), key = load('laya-key');
    if (!url || !key) throw new Error('Set the deployment URL and API key first.');
    const t = performance.now();
    const res = await fetch(url + '/v1/systemone?demo=' + encodeURIComponent(PAGE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ state, questions }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()));
    const out = { answers: (await res.json()).answers, ms: Math.round(performance.now() - t) };
    toast(out.ms);
    return out;
  }

  // RSS/Atom via the deployment's /feed route (most feeds send no CORS headers).
  // Returns [{ title, text, source }].
  async function feed(feedUrl) {
    const url = load('laya-url').replace(/\/+$/, ''), key = load('laya-key');
    if (!url || !key) throw new Error('Set the deployment URL and API key first.');
    const res = await fetch(url + '/feed?url=' + encodeURIComponent(feedUrl), { headers: { Authorization: 'Bearer ' + key } });
    if (!res.ok) throw new Error('feed: HTTP ' + res.status + ' ' + (await res.text()));
    const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
    const plain = html => (new DOMParser().parseFromString(html || '', 'text/html').body.textContent || '').replace(/\s+/g, ' ').trim();
    const pick = (el, sel) => { const n = el.querySelector(sel); return n ? n.textContent : ''; };
    const source = plain(pick(xml, 'channel > title, feed > title')) || new URL(feedUrl).hostname;
    return [...xml.querySelectorAll('item, entry')].map(el => ({
      title: plain(pick(el, 'title')),
      text: plain(pick(el, 'description') || pick(el, 'summary') || pick(el, 'content')).slice(0, 600),
      source,
    })).filter(i => i.title);
  }

  // "0.812  label" lines, highest first.
  const probs = p => Object.entries(p || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => v.toFixed(3) + '  ' + k).join('\n');

  // ---------------------------------------------------------------- which phone answers
  // Facts about the serving phone from GET /instance (country, chip, RAM, ...).
  let instance = null;
  const flag = cc => cc ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0))) : '📱';
  // Instance fields come from the phone (country via a geo-IP service): escape before HTML.
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const where = i => i && i.country ? `${flag(/^[A-Za-z]{2}$/.test(i.country_code || '') ? i.country_code : '')} ${i.country}` : 'somewhere in the world';
  async function loadInstance() {
    const { url } = config();
    if (!url) return null;
    try { instance = await (await fetch(url + '/instance')).json(); } catch (e) { instance = null; }
    renderBadge();
    return instance;
  }
  function renderBadge() {
    const el = document.querySelector('.acu-header .acu-phone');
    if (!el) return;
    if (!instance) { el.innerHTML = '<span class="muted">phone offline</span>'; return; }
    const i = instance;
    const spec = [i.chip, i.cores && `${i.cores} cores`, i.max_ghz && `${i.max_ghz} GHz`, i.ram_gb && `${Math.round(i.ram_gb)} GB RAM`].filter(Boolean).join(' · ');
    const link = i.processor ? `https://hub.acurast.com/explorer/address/${encodeURIComponent(i.processor)}` : null;
    el.innerHTML = `<div class="where">${esc(where(i))}</div><div class="spec">${esc(spec)}</div>
      <div class="spec"><b>${i.decisions.toLocaleString()}</b> decisions served${link ? ` · <a href="${link}" target="_blank" rel="noopener">verify on-chain</a>` : ''}</div>`;
    el.title = `Processor ${i.processor || '?'}\nDeployment ${i.deployment_id || '?'}\nProcessor app ${i.processor_version || '?'}`;
  }
  function toast(ms) {
    if (instance) instance.decisions++;
    renderBadge();
    const t = document.createElement('div');
    t.className = 'acu-toast';
    t.textContent = `answered by a ${instance ? instance.chip : 'phone'} in ${where(instance).replace(/^somewhere/, 'somewhere')} · ${(ms / 1000).toFixed(1)} s · no account, not logged`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // Official Acurast logo + favicon, inlined so the pages work even where only text files are
  // copied (the Hub playground skips images).
  const LOGO_SVG = '<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 75"><defs><style>.cls-1{fill:#fff;}.cls-2{fill:#b4e600;}</style></defs><path class="cls-1" d="M100.12,23.85l-11,27.3h6.55l2.75-7h15.87l2.75,7h6.55l-11-27.3Zm.77,14.77L104.1,30a2.46,2.46,0,0,1,4.61,0l3.21,8.6Z"/><path class="cls-1" d="M140,51.53h15.39V46H139.91c-3.92,0-9.45-2.64-9.45-8.51S136,29,139.91,29h15.43V23.47H140c-9.43,0-15.76,5.64-15.76,14S130.52,51.53,140,51.53Z"/><path class="cls-1" d="M176.06,46c-4.36,0-9.45-2.23-9.45-8.51V23.85h-6.27V37.5c0,8.39,6.33,14,15.76,14H179c9.4,0,16-5.77,16-14V23.85h-6.28V37.5c0,6.28-5.07,8.51-9.41,8.51Z"/><path class="cls-1" d="M223.86,43.32a9.68,9.68,0,0,0,5.06-8.84c0-6.66-5-10.63-13.31-10.63H200v27.3h6.27v-6h.63c9.3,0,9.86,0,10.4-.07l.36,0,4.27,6.13h6.16l-4.82-7.5Zm-8-3.72h-9.6V29.36h9.6c2.91,0,6.78.53,6.78,5.12S218.78,39.6,215.87,39.6Z"/><path class="cls-1" d="M242.5,23.85l-10.95,27.3h6.54l2.76-7h15.86l2.76,7H266l-10.95-27.3Zm.77,14.77,3.21-8.6a2.45,2.45,0,0,1,4.6,0l3.21,8.6Z"/><path class="cls-1" d="M287.3,34.25h-7.12c-2.91,0-5.65,0-5.65-2.44s2.74-2.45,5.65-2.45H297.6V23.85H280.18c-10.69,0-11.92,4.65-11.92,8.15,0,6.88,6.37,7.77,11.92,7.77h8c1.34,0,5.42,0,5.42,3.2,0,2.47-2.45,2.67-5.42,2.67H269.43v5.51H287.3c10.93,0,12.56-5.29,12.56-8.45C299.86,35.35,292,34.25,287.3,34.25Z"/><polygon class="cls-1" points="315.95 51.15 322.22 51.15 322.26 29.36 335.98 29.36 335.98 23.85 302.6 23.85 302.6 29.36 315.95 29.36 315.95 51.15"/><polygon class="cls-2" points="55.01 17 31.1 17 14.02 51.16 37.93 51.16 55.01 17"/><polygon class="cls-2" points="48.18 37.5 68.67 37.5 78.92 57.99 58.43 57.99 48.18 37.5"/></svg>';
  const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 12 72 50"><rect x="10" y="12" width="72" height="50" rx="8" fill="#0f0f0f"/><polygon fill="#b4e600" points="55.01 17 31.1 17 14.02 51.16 37.93 51.16 55.01 17"/><polygon fill="#b4e600" points="48.18 37.5 68.67 37.5 78.92 57.99 58.43 57.99 48.18 37.5"/></svg>';
  const svgUrl = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  // ---------------------------------------------------------------- tracking (aggregate only)
  // No cookies, no IDs, no IPs: the phone only counts events per page (see /stats).
  const PAGE = (location.pathname.split('/').pop() || 'index.html').replace('.html', '') || 'index';
  const UTM = { utm_source: 'laya-demos', utm_medium: 'referral', utm_campaign: 'laya', utm_content: PAGE };
  const tag = href => { const u = new URL(href); Object.entries(UTM).forEach(([k, v]) => u.searchParams.set(k, v)); return u.toString(); };
  function hit(event) {
    const { url } = config();
    if (!url) return;
    try { navigator.sendBeacon(`${url}/hit?e=${encodeURIComponent(event)}&p=${encodeURIComponent(PAGE)}`); } catch (e) {}
  }
  // Tag every outgoing Acurast link (Hub, docs, site) and count the click.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    const host = new URL(a.href).hostname;
    if (/(^|\.)acurast\.com$/.test(host)) { a.href = tag(a.href); hit('out:' + host.split('.')[0]); }
  }, true);

  // The running instance's public link for this page, tagged for shares.
  function shareLink(source) {
    const base = /^https?:/.test(location.protocol) ? location.origin + location.pathname : config().url + '/' + PAGE + '.html';
    return `${base}?utm_source=${source}&utm_medium=share&utm_campaign=laya&utm_content=${PAGE}`;
  }
  const pageName = () => document.title.replace(/\s*·\s*Acurast$/, '');
  // Trending tags on X right now (Laya vs. TypeSafe's Jev); added via the intent's own parameter.
  const HASHTAGS = ['Laya', 'Jev'];
  function shareOnX(text) {
    hit('share:x');
    const t = text || `${pageName()}: decisions made by Laya, an open AI model running on a phone in the @Acurast Cloud. Try it live:`;
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(t)}&url=${encodeURIComponent(shareLink('x'))}&hashtags=${HASHTAGS.join(',')}`, '_blank', 'noopener');
  }

  // ---------------------------------------------------------------- shareable result image
  // A branded 1200x630 card. Phones: native share sheet with the image attached.
  // Desktop: download the PNG and open a prefilled X post to attach it to.
  const logoImg = new Image(); logoImg.src = svgUrl(LOGO_SVG);
  async function shareResult({ kicker, big, detail, text }) {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
    const g = c.getContext('2d');
    await document.fonts.ready;
    g.fillStyle = '#0f0f0f'; g.fillRect(0, 0, 1200, 630);
    g.fillStyle = '#c0e700'; for (let x = 0; x < 1200; x += 24) g.fillRect(x, 606, 12, 12);   // pixel strip
    g.fillStyle = '#181818'; g.fillRect(60, 150, 1080, 380);
    g.strokeStyle = '#c0e700'; g.lineWidth = 6; g.strokeRect(60, 150, 1080, 380);
    if (logoImg.complete && logoImg.naturalWidth) g.drawImage(logoImg, 60, 50, 280, 60);
    g.fillStyle = '#9a9a9a'; g.font = '26px Silkscreen, monospace'; g.textAlign = 'right';
    g.fillText(`LAYA ${pageName().replace(/^Laya\s*/, '').toUpperCase()}`, 1140, 92);
    g.textAlign = 'left';
    const wrap = (txt, x, y, max, lh, n) => {
      const words = String(txt).split(/\s+/); let line = '', lines = 0;
      for (const w of words) {
        if (g.measureText(line + w).width > max && line) { g.fillText(line.trim(), x, y); y += lh; line = ''; if (++lines >= n - 1) { line = words.slice(words.indexOf(w)).join(' '); break; } }
        line += w + ' ';
      }
      let last = line.trim(); while (g.measureText(last).width > max && last.length > 3) last = last.slice(0, -4) + '…';
      g.fillText(last, x, y); return y + lh;
    };
    g.fillStyle = '#9a9a9a'; g.font = '30px Saira, sans-serif'; let y = wrap(kicker || '', 100, 215, 1000, 40, 2);
    g.fillStyle = '#c0e700'; g.font = 'bold 64px Silkscreen, monospace'; y = wrap(big || '', 100, y + 50, 1000, 74, 2);
    g.fillStyle = '#f5f5f5'; g.font = '28px Saira, sans-serif'; wrap(detail || '', 100, y + 10, 1000, 38, 2);
    g.fillStyle = '#9a9a9a'; g.font = '24px Saira, sans-serif';
    g.fillText(`Answered by a phone${instance && instance.country ? ' in ' + instance.country : ''} in the Acurast Cloud · no account, not logged`, 60, 580);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], `laya-${PAGE}.png`, { type: 'image/png' });
    const msg = text || `${big}. Decided by an open AI model on a phone in the @Acurast Cloud.`;
    hit('share:image');
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: `${msg} ${HASHTAGS.map(h => '#' + h).join(' ')} ${shareLink('share-sheet')}` }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
    shareOnX(msg + ' (image attached)');
  }

  // "Share this result" button after `after` (default: the page's log); updates to the latest result.
  let lastShare = null;
  function offerShare(data, after) {
    lastShare = data;
    let b = document.querySelector('.share-result');
    if (!b) {
      b = document.createElement('button');
      b.className = 'share-result'; b.textContent = 'Share this result';
      b.onclick = () => shareResult(lastShare);
      (after || document.querySelector('#log, .log') || document.querySelector('main') || document.body).after(b);
    }
  }

  // ---------------------------------------------------------------- header, footer, embed
  const EMBED = new URLSearchParams(location.search).has('embed');
  function brand() {
    const home = PAGE === 'index';
    // Favicon for every page.
    const icon = document.createElement('link'); icon.rel = 'icon'; icon.type = 'image/svg+xml'; icon.href = svgUrl(FAVICON_SVG);
    document.head.appendChild(icon);
    document.querySelectorAll('a.back').forEach(a => a.remove());
    const panel = settingsPanel();

    if (EMBED) {
      // Embedded in someone else's page: slim brand strip instead of the header/footer.
      document.body.classList.add('embed');
      const b = document.createElement('a');
      b.className = 'acu-embed'; b.target = '_blank'; b.rel = 'noopener';
      b.href = shareLink('embed');
      b.innerHTML = `<img src="${svgUrl(LOGO_SVG)}" alt="Acurast"> <span>Laya on a phone · open full demo ↗</span>`;
      document.body.prepend(b);
    } else {
      const h = document.createElement('header');
      h.className = 'acu-header';
      h.innerHTML = `<a class="logo-link" href="${tag('https://acurast.com/')}" target="_blank" rel="noopener" title="acurast.com"><img class="logo" src="${svgUrl(LOGO_SVG)}" alt="Acurast"></a>
        <a class="home" href="index.html"><div><div class="brand">LAYA <b>DEMOS</b></div>
        <div class="tag"><span class="dot"></span>decisions made on a phone in the Acurast Cloud</div></div></a>
        <div class="spacer"></div><div class="acu-phone"></div>${home ? '' : '<a class="all" href="index.html">&larr; <span>all demos</span></a>'}
        <button class="share" title="Share on X">Share <span>on</span> 𝕏</button>
        <button class="gear" title="Settings" aria-label="Settings">&#9881;</button>`;
      document.body.prepend(h);
      h.querySelector('.gear').onclick = () => panel.showModal();
      h.querySelector('.share').onclick = () => shareOnX();

      const f = document.createElement('footer');
      f.className = 'acu-footer';
      f.innerHTML = `<div class="cta"><div><b>This runs on one phone for a few ACU a day.</b><br><span class="muted">Deploy your own Laya instance on Acurast in minutes.</span></div>
          <a class="button" href="${tag('https://hub.acurast.com/playground')}" target="_blank" rel="noopener">Deploy your own &rarr;</a></div>
        <nav><a href="${tag('https://acurast.com/')}" target="_blank" rel="noopener">acurast.com</a>
          <a href="${tag('https://docs.acurast.com/')}" target="_blank" rel="noopener">Docs</a>
          <a href="${tag('https://hub.acurast.com/')}" target="_blank" rel="noopener">Hub</a>
          <a href="https://x.com/Acurast" target="_blank" rel="noopener">@Acurast</a>
          <a href="api.html">API</a><a href="stats.html">Stats</a></nav>
        <div class="credit muted">Model: <a href="https://huggingface.co/convaiinnovations/laya" target="_blank" rel="noopener">Laya</a> by Convai Innovations (Apache-2.0), running unmodified on a phone.</div>`;
      document.body.appendChild(f);
    }
    // No URL/key at all: open settings right away.
    if (!config().url || !config().key) panel.showModal();
    loadInstance();
    setInterval(loadInstance, 30000); // keep the decisions counter fresh
    hit('view');
  }
  brand();

  return { ask, feed, probs, config, instance: () => instance, where: () => where(instance), shareResult, offerShare, shareOnX, hit };
})();
