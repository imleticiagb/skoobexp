// Clicking the toolbar icon opens the export panel on a Skoob tab
// (or opens Skoob first if the current tab is elsewhere).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !/^https:\/\/([a-z0-9-]+\.)?skoob\.com\.br\//.test(tab.url)) {
    await chrome.tabs.create({ url: "https://www.skoob.com.br/pt/home" });
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["goodreads.js", "content.js"],
  });
});

// The Skoob API token lives in an httpOnly cookie, which page scripts
// cannot read; only the extension's cookies API can.
const EXTERNAL = /^https:\/\/(openlibrary\.org|www\.googleapis\.com)\//;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // ISBN lookups on external catalogs go through here to avoid the page's
  // CORS/CSP rules.
  if (msg && msg.type === "fetchJson" && EXTERNAL.test(msg.url)) {
    fetch(msg.url)
      .then(async (r) => sendResponse(r.ok ? { data: await r.json() } : { status: r.status }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  // Fallback when the page can't see the cookie: returns the first cookie
  // holding a JWT (header.payload.signature).
  if (msg && msg.type === "getToken") {
    (async () => {
      for (const name of ["tokenClient", "token"]) {
        const c = await chrome.cookies.get({ url: "https://www.skoob.com.br/", name });
        const v = c ? decodeURIComponent(c.value) : "";
        if (v.split(".").length === 3) return v;
      }
      return null;
    })()
      .then((token) => sendResponse({ token }))
      .catch((e) => sendResponse({ token: null, error: String(e) }));
    return true;
  }
});
