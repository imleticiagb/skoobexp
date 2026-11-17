// Pure conversion from Skoob data to a Goodreads "library export" CSV.
// No browser APIs here, so it can be unit-tested with Node.
(function (root) {
  const COLUMNS = [
    "Title", "Author", "Author l-f", "Additional Authors", "ISBN", "ISBN13",
    "My Rating", "Publisher", "Binding", "Number of Pages", "Year Published",
    "Original Publication Year", "Date Read", "Date Added", "Bookshelves",
    "Bookshelves with positions", "Exclusive Shelf", "My Review", "Spoiler",
    "Private Notes", "Read Count", "Owned Copies",
  ];

  // Skoob reading status -> Goodreads exclusive shelf.
  const STATUS_SHELF = {
    read: "read",
    reading: "currently-reading",
    rereading: "currently-reading",
    want_to_read: "to-read",
  };

  // Skoob labels (bookshelf filters) -> Goodreads custom shelf names.
  const LABEL_SHELF = {
    favorited: "favorites",
    owned: "owned",
    desired: "wishlist",
    traded: "to-trade",
    lent: "lent",
  };

  const DEFAULT_OPTIONS = {
    abandonedShelf: "did-not-finish",
    roundRatings: true,
    htmlLineBreaks: true,
    excelIsbn: true,
  };

  function authorLastFirst(name) {
    const n = (name || "").trim();
    if (!n || n.includes(",")) return n;
    const parts = n.split(/\s+/);
    if (parts.length < 2) return n;
    const last = parts.pop();
    return `${last}, ${parts.join(" ")}`;
  }

  // "19/12/2025" -> "2025/12/19"
  function brDateToGoodreads(s) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || "").trim());
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  }

  // "2025-12-19T13:07:43.690Z" -> "2025/12/19" (in the user's local timezone)
  function isoToGoodreads(s) {
    if (!s) return "";
    const d = new Date(s);
    if (isNaN(d)) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  }

  // Skoob sometimes stores an Amazon ASIN (e.g. "B07GL39MCW") in the ISBN
  // fields of ebooks; anything that isn't a real ISBN is dropped.
  function cleanIsbn(s, length) {
    const v = (s || "").replace(/[-\s]/g, "").toUpperCase();
    const ok = length === 10 ? /^\d{9}[\dX]$/.test(v) : /^97[89]\d{10}$/.test(v);
    return ok ? v : "";
  }

  function formatIsbn(s, length, excel) {
    const v = cleanIsbn(s, length);
    return excel ? `="${v}"` : v;
  }

  function formatRating(r, round) {
    if (r == null || isNaN(r) || r <= 0) return "0";
    if (!round) return String(r);
    return String(Math.min(5, Math.max(1, Math.round(r))));
  }

  function formatReview(review, html) {
    if (!review) return "";
    const title = (review.title || "").trim();
    const text = (review.text || "").trim();
    const full = title && text ? `${title}\n\n${text}` : title || text;
    if (!html) return full;
    const esc = full.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc.replace(/\r?\n/g, "<br/>");
  }

  // Finds the JSON object/array starting at `start` (which must point at
  // "{" or "[") and returns its source text, respecting string literals.
  function sliceBalanced(src, start) {
    const open = src[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return src.slice(start, i + 1);
    }
    return null;
  }

  // Joins the React Server Components payload embedded in a Next.js page.
  function extractFlight(html) {
    const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
    let out = "";
    let m;
    while ((m = re.exec(html))) out += JSON.parse(`"${m[1]}"`);
    return out;
  }

  // Pulls the per-edition details the bookshelf API does not return
  // (ISBNs, all authors, date added) out of a /pt/book/<edition_id> page.
  function parseBookPage(html, editionId) {
    const flight = extractFlight(html);
    const marker = `"book":{"edition_id":${editionId},`;
    const at = flight.indexOf(marker);
    if (at < 0) return null;
    const json = sliceBalanced(flight, at + '"book":'.length);
    if (!json) return null;
    const book = JSON.parse(json);
    const steps = (book.reading_journey && book.reading_journey.steps) || [];
    const step = (type) => (steps.find((s) => s.type === type) || {}).value || "";
    const authors = ((book.authors && book.authors.items) || []).map((a) => a.name).filter(Boolean);
    const others = ((book.book_sections || []).find((s) => s.section === "other-editions") || {}).items || [];
    return {
      isbn10: book.isbn10 || "",
      isbn13: book.isbn13 || "",
      language: book.language || "",
      otherEditions: others
        .filter((e) => e.edition_id !== editionId)
        .map((e) => ({ edition_id: e.edition_id, publisher: e.publisher || "", language: e.language || "", year: e.year })),
      authors,
      dateAdded: brDateToGoodreads(step("add_bookshelf")),
      dateRead: brDateToGoodreads(step("reading_date")),
    };
  }

  function hasIsbn(d) {
    return !!d && !!(cleanIsbn(d.isbn13, 13) || cleanIsbn(d.isbn10, 10));
  }

  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

  // "Cinder (As crônicas lunares Livro 1)" -> "Cinder"; keeps "#3" when it
  // is part of the title itself ("Killing Stalking #3") so volumes differ.
  function searchTitle(title) {
    return (title || "").replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ").trim();
  }

  // Series/volume number, e.g. "Cinder (Crônicas Lunares #1)" -> "1".
  const volume = (t) => ((t || "").match(/#\s*(\d+(?:\.\d+)?)/) || [])[1] || "";

  function titlesMatch(a, b) {
    const x = norm(searchTitle(a));
    const y = norm(searchTitle(b));
    if (!x || !y) return false;
    if (volume(a) && volume(b) && volume(a) !== volume(b)) return false;
    if (x === y) return true;
    // "Levana: A rainha mais bela" vs "Levana"
    const head = (s) => norm(searchTitle(s).split(":")[0]);
    return head(a) === head(b) && head(a).length >= 4;
  }

  function authorsMatch(a, b) {
    const x = norm(a).split(" ").filter((w) => w.length > 1);
    const y = new Set(norm(b).split(" "));
    return x.length > 0 && x.some((w) => w.length > 2 && y.has(w));
  }

  const isPortuguese = (lang) => /portugu|^por$|^pt/i.test(lang || "");

  // Ranks candidate editions: same volume first, then same publisher, then
  // Portuguese.
  function rankEditions(list, publisher, title) {
    const pub = norm(publisher);
    const vol = volume(title);
    const score = (e) => (volume(e.title) === vol ? 4 : 0) +
      (pub && norm(e.publisher) === pub ? 2 : 0) + (isPortuguese(e.language) ? 1 : 0);
    return [...list].sort((a, b) => score(b) - score(a));
  }

  // Picks the best ISBN from Open Library edition entries.
  function pickOpenLibraryIsbn(entries) {
    const ids = (e) => ({
      isbn13: (e.isbn_13 || []).find((s) => cleanIsbn(s, 13)) || "",
      isbn10: (e.isbn_10 || []).find((s) => cleanIsbn(s, 10)) || "",
    });
    const withIsbn = (entries || []).filter((e) => hasIsbn(ids(e)));
    const por = withIsbn.filter((e) => (e.languages || []).some((l) => /\/por$/.test(l.key)));
    const e = por[0] || withIsbn[0];
    return e ? ids(e) : null;
  }

  // Picks the best ISBN from Google Books volumes matching title/author.
  function pickGoogleIsbn(items, title, author) {
    const ok = (items || []).map((v) => v.volumeInfo || {}).filter((v) =>
      titlesMatch(v.title, title) && (v.authors || []).some((a) => authorsMatch(author, a)));
    const ids = (v) => Object.fromEntries((v.industryIdentifiers || []).map((x) => [x.type, x.identifier]));
    const sorted = [...ok.filter((v) => v.language === "pt"), ...ok.filter((v) => v.language !== "pt")];
    for (const v of sorted) {
      const i = ids(v);
      const r = { isbn13: i.ISBN_13 || "", isbn10: i.ISBN_10 || "" };
      if (hasIsbn(r)) return r;
    }
    return null;
  }

  // item: entry from /v1/bookshelf; details: parseBookPage() result or null;
  // labels: Set of Skoob label types; review: entry from /v1/feed/personal.
  function toRow(item, details, labels, review, positions, options) {
    const o = { ...DEFAULT_OPTIONS, ...options };
    const d = details || {};
    // The shelf's author is Skoob's main author; the book page lists all
    // credited people in no particular order.
    const main = item.author || (d.authors && d.authors[0]) || "";
    const authors = [main, ...(d.authors || []).filter((a) => a !== main)];
    const exclusive = item.status === "abandoned"
      ? o.abandonedShelf
      : STATUS_SHELF[item.status] || "to-read";

    const shelves = [];
    if (exclusive !== "read") shelves.push(exclusive);
    for (const [label, shelf] of Object.entries(LABEL_SHELF)) {
      if (labels && labels.has(label)) shelves.push(shelf);
    }
    const withPos = shelves.map((s) => {
      const p = positions && positions[s] && positions[s].get(item.edition_id);
      return p ? `${s} (#${p})` : s;
    });

    const dateRead = item.status === "read"
      ? isoToGoodreads(item.finished_at) || d.dateRead || ""
      : "";

    return {
      "Title": item.title || "",
      "Author": authors[0],
      "Author l-f": authorLastFirst(authors[0]),
      "Additional Authors": authors.slice(1).join(", "),
      "ISBN": formatIsbn(d.isbn10, 10, o.excelIsbn),
      "ISBN13": formatIsbn(d.isbn13, 13, o.excelIsbn),
      "My Rating": formatRating(item.rating, o.roundRatings),
      "Publisher": item.publisher || "",
      "Binding": "",
      "Number of Pages": item.pages ? String(item.pages) : "",
      "Year Published": item.year ? String(item.year) : "",
      "Original Publication Year": "",
      "Date Read": dateRead,
      "Date Added": d.dateAdded || "",
      "Bookshelves": shelves.join(", "),
      "Bookshelves with positions": withPos.join(", "),
      "Exclusive Shelf": exclusive,
      "My Review": formatReview(review, o.htmlLineBreaks),
      "Spoiler": review && review.is_spoiler ? "true" : "",
      "Private Notes": "",
      "Read Count": item.status === "read" ? "1" : "0",
      "Owned Copies": labels && labels.has("owned") ? "1" : "0",
    };
  }

  function csvField(v) {
    const s = v == null ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  }

  function toCsv(rows) {
    const lines = [COLUMNS.join(",")];
    for (const r of rows) lines.push(COLUMNS.map((c) => csvField(r[c])).join(","));
    return lines.join("\n") + "\n";
  }

  const api = {
    COLUMNS, LABEL_SHELF, DEFAULT_OPTIONS,
    authorLastFirst, brDateToGoodreads, isoToGoodreads, formatRating,
    formatReview, extractFlight, parseBookPage, toRow, toCsv,
    hasIsbn, searchTitle, titlesMatch, authorsMatch, rankEditions,
    pickOpenLibraryIsbn, pickGoogleIsbn,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SkoobGR = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
