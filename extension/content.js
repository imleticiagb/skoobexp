// Export panel injected into a skoob.com.br tab. Runs in the page's origin,
// so book pages are fetched with the user's session and the API accepts the
// requests (CORS allows www.skoob.com.br).
(function () {
  if (window.__skoobExporter) {
    window.__skoobExporter.show();
    return;
  }

  const API = "https://prd-api.skoob.com.br/api";
  const GR = window.SkoobGR;
  const PAGE_LIMIT = 100;
  const CONCURRENCY = 4;
  const LABELS = Object.keys(GR.LABEL_SHELF);

  // ---------- UI ----------
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .p{width:340px;font:14px/1.4 system-ui,sans-serif;color:#1d1d1f;background:#fff;
         border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.25);padding:16px}
      h2{font-size:16px;margin:0 0 4px}
      .sub{color:#666;font-size:12px;margin:0 0 12px}
      label{display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:13px}
      input[type=text]{width:130px;padding:2px 6px;border:1px solid #ccc;border-radius:4px}
      button{border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
      .go{background:#2e7d5b;color:#fff;width:100%;margin-top:10px}
      .go:disabled{opacity:.5;cursor:default}
      .x{position:absolute;top:8px;right:8px;background:none;font-size:18px;padding:4px 8px;color:#666}
      .bar{height:6px;background:#eee;border-radius:3px;margin:12px 0 6px;overflow:hidden}
      .bar>div{height:100%;width:0;background:#2e7d5b;transition:width .2s}
      .log{font-size:12px;color:#444;max-height:120px;overflow:auto;white-space:pre-wrap}
      .err{color:#b00020}
    </style>
    <div class="p">
      <button class="x" title="Fechar">×</button>
      <h2>Skoob Exporter</h2>
      <p class="sub">Gera um CSV no formato do Goodreads (aceito pelo Maratona).</p>
      <label><input type="checkbox" id="round" checked>
        <span>Arredondar meias estrelas (Goodreads só aceita notas inteiras; 3,5 → 4)</span></label>
      <label><input type="checkbox" id="html" checked>
        <span>Quebras de linha das resenhas como &lt;br/&gt; (padrão do Goodreads)</span></label>
      <label><input type="checkbox" id="excel" checked>
        <span>ISBN no formato ="…" (padrão do Goodreads)</span></label>
      <label><span>Prateleira para "Abandonei":</span>
        <input type="text" id="abandoned" value="did-not-finish"></label>
      <button class="go">Exportar estante</button>
      <div class="bar"><div></div></div>
      <div class="log"></div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => shadow.querySelector(s);
  const bar = $(".bar>div");
  const logEl = $(".log");
  const goBtn = $(".go");
  const log = (msg, isErr) => {
    const line = document.createElement("div");
    if (isErr) line.className = "err";
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  };
  const progress = (frac) => { bar.style.width = `${Math.round(frac * 100)}%`; };
  $(".x").onclick = () => { host.style.display = "none"; };

  window.__skoobExporter = { show: () => { host.style.display = ""; } };

  // ---------- data ----------
  // The API token is the JWT the site keeps in the "tokenClient" cookie;
  // its payload carries the user id.
  function userIdFromToken(token) {
    try {
      const part = (token || "").split(".")[1];
      if (!part) return null;
      const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
      return JSON.parse(json).id || null;
    } catch (e) {
      return null;
    }
  }

  function pageCookie(name) {
    const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
  }

  async function getToken() {
    const fromPage = pageCookie("tokenClient");
    if (userIdFromToken(fromPage)) return fromPage;
    const r = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "getToken" }, resolve));
    return r && userIdFromToken(r.token) ? r.token : null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withRetry(fn, tries = 3) {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= tries) throw e;
        await sleep(1000 * i);
      }
    }
  }

  async function api(token, path) {
    return withRetry(async () => {
      const r = await fetch(API + path, { headers: { Authorization: token } });
      if (!r.ok) throw new Error(`HTTP ${r.status} em ${path}`);
      return r.json();
    });
  }

  async function shelf(token, userId, filter) {
    const items = [];
    for (let page = 1; ; page++) {
      const q = `page=${page}&limit=${PAGE_LIMIT}&bookshelf_type=book&user_id=${userId}&filter=${filter}`;
      const r = await api(token, `/v1/bookshelf?${q}`);
      items.push(...(r.items || []));
      if (!r.items || !r.items.length || page >= (r.total_pages || 1)) break;
    }
    return items;
  }

  async function reviews(token, userId) {
    const items = [];
    for (let page = 1; ; page++) {
      const r = await api(token, `/v1/feed/personal?page=${page}&limit=20&user_id=${userId}&type=review`);
      items.push(...(r.items || []));
      if (!r.items || !r.items.length || (r.total_pages && page >= r.total_pages)) break;
    }
    return items;
  }

  async function bookDetails(editionId) {
    return withRetry(async () => {
      const r = await fetch(`/pt/book/${editionId}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return GR.parseBookPage(await r.text(), editionId);
    });
  }

  function externalJson(url) {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: "fetchJson", url }, (r) => resolve(r && r.data)));
  }

  // ISBN of a Skoob edition page, or null.
  async function editionIsbn(editionId) {
    try {
      const d = await bookDetails(editionId);
      return GR.hasIsbn(d) ? { isbn13: d.isbn13, isbn10: d.isbn10, editionId } : null;
    } catch (e) {
      return null;
    }
  }

  // Finds an ISBN for a book whose own Skoob edition has none, trying other
  // editions on Skoob, then Skoob search, Open Library and Google Books.
  async function findIsbn(token, b, d) {
    for (const e of GR.rankEditions((d && d.otherEditions) || [], b.publisher, b.title).slice(0, 5)) {
      const r = await editionIsbn(e.edition_id);
      if (r) return { ...r, source: "outra edição no Skoob" };
    }

    const title = GR.searchTitle(b.title);
    try {
      const q = encodeURIComponent(`${title} ${b.author || ""}`.trim());
      const s = await api(token, `/v1/search/book?search_term=${q}&page=1&limit=20`);
      const matches = (s.items || []).filter((c) => c.edition_id !== b.edition_id &&
        GR.titlesMatch(c.title, b.title) && GR.authorsMatch(b.author, c.author));
      for (const c of GR.rankEditions(matches, b.publisher, b.title).slice(0, 5)) {
        const r = await editionIsbn(c.edition_id);
        if (r) return { ...r, source: "busca no Skoob" };
      }
    } catch (e) { /* fall through to external catalogs */ }

    const ol = await externalJson("https://openlibrary.org/search.json?limit=5&fields=key,title,author_name" +
      `&title=${encodeURIComponent(title)}&author=${encodeURIComponent(b.author || "")}`);
    const work = ((ol && ol.docs) || []).find((w) => GR.titlesMatch(w.title, b.title));
    if (work) {
      const eds = await externalJson(`https://openlibrary.org${work.key}/editions.json?limit=100`);
      const r = GR.pickOpenLibraryIsbn(eds && eds.entries);
      if (GR.hasIsbn(r)) return { ...r, source: "Open Library" };
    }

    const g = await externalJson("https://www.googleapis.com/books/v1/volumes?maxResults=10&q=" +
      encodeURIComponent(`intitle:${title} inauthor:${b.author || ""}`));
    const r = GR.pickGoogleIsbn(g && g.items, b.title, b.author);
    if (r) return { ...r, source: "Google Books" };
    return null;
  }

  async function mapPool(list, n, fn) {
    const out = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    }));
    return out;
  }

  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function run() {
    const options = {
      roundRatings: $("#round").checked,
      htmlLineBreaks: $("#html").checked,
      excelIsbn: $("#excel").checked,
      abandonedShelf: $("#abandoned").value.trim() || "did-not-finish",
    };

    const token = await getToken();
    if (!token) throw new Error("Você não está logado no Skoob. Faça login e tente de novo.");
    const userId = userIdFromToken(token);

    log("Lendo a estante…");
    const books = await shelf(token, userId, "all");
    log(`${books.length} livros encontrados.`);
    progress(0.05);

    const labelsByEdition = new Map();
    const positions = {};
    for (const label of LABELS) {
      const items = await shelf(token, userId, label);
      const pos = new Map();
      items.forEach((it, i) => {
        if (!labelsByEdition.has(it.edition_id)) labelsByEdition.set(it.edition_id, new Set());
        labelsByEdition.get(it.edition_id).add(label);
        pos.set(it.edition_id, i + 1);
      });
      positions[GR.LABEL_SHELF[label]] = pos;
      if (items.length) log(`Etiqueta "${GR.LABEL_SHELF[label]}": ${items.length}`);
    }
    // Positions for exclusive shelves, in shelf order.
    const excl = {};
    for (const b of books) {
      const s = b.status === "abandoned" ? options.abandonedShelf
        : { reading: "currently-reading", rereading: "currently-reading", want_to_read: "to-read" }[b.status];
      if (!s) continue;
      if (!positions[s]) positions[s] = new Map();
      excl[s] = (excl[s] || 0) + 1;
      positions[s].set(b.edition_id, excl[s]);
    }

    log("Lendo resenhas…");
    const revs = await reviews(token, userId);
    const revByEdition = new Map();
    const revByBook = new Map();
    for (const r of revs) {
      if (!r.book) continue;
      revByEdition.set(r.book.edition_id, r);
      revByBook.set(r.book.book_id, r);
    }
    log(`${revs.length} resenhas encontradas.`);
    progress(0.1);

    log("Buscando ISBN e datas de cada livro (pode levar alguns minutos)…");
    let done = 0;
    let failed = 0;
    const details = await mapPool(books, CONCURRENCY, async (b) => {
      let d = null;
      try { d = await bookDetails(b.edition_id); } catch (e) { /* counted below */ }
      if (!d) { failed++; log(`Sem detalhes: ${b.title}`, true); }
      done++;
      progress(0.1 + 0.8 * (done / books.length));
      return d;
    });

    const missing = books.map((b, i) => i).filter((i) => !GR.hasIsbn(details[i]));
    let foundOutside = 0;
    if (missing.length) {
      log(`${missing.length} livros sem ISBN no Skoob. Procurando em outras fontes…`);
      let checked = 0;
      await mapPool(missing, 2, async (i) => {
        const b = books[i];
        const r = await findIsbn(token, b, details[i]);
        if (r) {
          details[i] = { ...(details[i] || { authors: [] }), isbn13: r.isbn13, isbn10: r.isbn10 };
          foundOutside++;
          log(`ISBN de "${b.title}" encontrado (${r.source}).`);
        } else {
          log(`Sem ISBN em nenhuma fonte: ${b.title} (vai sem ISBN no CSV)`, true);
        }
        checked++;
        progress(0.9 + 0.08 * (checked / missing.length));
      });
    }

    const rows = books.map((b, i) => GR.toRow(
      b,
      details[i],
      labelsByEdition.get(b.edition_id),
      revByEdition.get(b.edition_id) || revByBook.get(b.book_id),
      positions,
      options,
    ));

    const csv = GR.toCsv(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    download(csv, `skoob_goodreads_export_${stamp}.csv`);
    progress(1);
    const withReview = rows.filter((r) => r["My Review"]).length;
    const noIsbn = missing.length - foundOutside;
    log(`Pronto! ${rows.length} livros exportados, ${withReview} com resenha. ` +
      `${foundOutside} ISBNs vieram de outras fontes; ${noIsbn} livros seguem sem ISBN.` +
      (failed ? ` ${failed} páginas de livro falharam (sem data de adição).` : ""));
  }

  goBtn.onclick = async () => {
    goBtn.disabled = true;
    logEl.textContent = "";
    progress(0);
    try { await run(); } catch (e) { log(`Erro: ${e.message}`, true); }
    goBtn.disabled = false;
  };
})();
