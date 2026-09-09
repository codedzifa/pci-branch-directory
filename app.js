/* ============================================================
   Perez Chapel International — Ghana Branch Directory
   Central logic: data · search · filters · map · near-me · URL state
   Vanilla JS (no build step). Leaflet + PapaParse.
   ============================================================ */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     0. Constants & tiny helpers
  --------------------------------------------------------- */
  const GHANA_CENTER = [7.9465, -1.0232];
  const PAGE_SIZE = 24;
  const CONTACT_PHONE = "024-350-0626";
  const CONTACT_EMAIL = "missions.admin@perezchapel.org";

  const STATUS_META = {
    active:          { color: "#1d9e75", label: "Active" },
    growing:         { color: "#2f74c0", label: "Growing" },
    "needs-support": { color: "#d9743a", label: "Needs support" }
  };
  const UNAVAILABLE = "Information unavailable";

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  function debounce(fn, ms) {
    let t;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }
  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
      .replace(/\bNo\.\b/gi, "No.");
  }
  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function normSpace(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

  /* treat placeholder / bare-title values as "no real value" */
  function realValue(v) {
    const t = normSpace(v);
    if (!t) return "";
    if (/^(n\/?a|na|none|-|—|tbd)$/i.test(t)) return "";
    return t;
  }
  function realPastor(v) {
    const t = realValue(v);
    if (!t) return "";
    // bare titles / land markers are not usable pastor names
    if (/^(rev\.?|ps\.?|pr\.?|pastor|elder|eld\.?|deac\.?|bishop|land)$/i.test(t)) return "";
    return t;
  }
  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function telHref(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "";
    // Ghana local 0XXXXXXXXX -> +233XXXXXXXXX
    if (digits.length === 10 && digits.startsWith("0")) return "tel:+233" + digits.slice(1);
    return "tel:" + (digits.startsWith("233") ? "+" + digits : digits);
  }
  function haversine(a, b, c, d) {
    const R = 6371, toR = (x) => (x * Math.PI) / 180;
    const dLat = toR(c - a), dLon = toR(d - b);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function fmtDist(km) {
    if (km == null) return "";
    if (km < 1) return Math.round(km * 1000) + " m away";
    if (km < 10) return km.toFixed(1) + " km away";
    return Math.round(km) + " km away";
  }

  /* ---------------------------------------------------------
     1. State
  --------------------------------------------------------- */
  const state = {
    query: "",
    filters: { region: "", branch: "", pastor: "", city: "", status: "" },
    sort: "relevance",
    view: "list",
    shown: PAGE_SIZE,
    userLoc: null,
    geoDenied: false
  };

  let ALL = [];        // normalized branches
  let CURRENT = [];    // current filtered+sorted result
  let map = null, markerLayer = null, mapReady = false;

  /* ---------------------------------------------------------
     2. Data layer — load + normalize (never mutate meaning)
  --------------------------------------------------------- */
  function normalize(rows) {
    return rows
      .filter((r) => normSpace(r.branch_name))
      .map((r, i) => {
        const region = normSpace(r.region).toUpperCase();
        const branch = titleCase(normSpace(r.branch_name));
        const city = titleCase(realValue(r.address));
        const pastorRaw = realPastor(r.pastor);
        const lat = parseFloat(r.latitude);
        const lng = parseFloat(r.longitude);
        const hasCoords = !isNaN(lat) && !isNaN(lng);
        const status = STATUS_META[r.status] ? r.status : "";
        const id = slugify(branch) + "-" + (hasCoords ? Math.round(lat * 1e4) + "" + Math.round(Math.abs(lng) * 1e4) : "x" + i);
        return {
          id, i,
          region,
          regionLabel: titleCase(region),
          branch,
          city,                                   // location / city (from address)
          address: realValue(r.address),
          pastor: pastorRaw,                      // "" if unavailable
          pastorDisplay: pastorRaw || UNAVAILABLE,
          phone: realValue(r.phone) || CONTACT_PHONE,
          email: realValue(r.email) || CONTACT_EMAIL,
          year: realValue(r.year_founded),
          status,
          statusLabel: status ? STATUS_META[status].label : "",
          photo: realValue(r.photo_url),
          lat: hasCoords ? lat : null,
          lng: hasCoords ? lng : null,
          hasCoords,
          _search: [branch, pastorRaw, city, region, r.address].map((x) => String(x || "").toLowerCase()).join(" ¦ "),
          dist: null
        };
      });
  }

  /* ---------------------------------------------------------
     3. Search + filter + sort engine
  --------------------------------------------------------- */
  function scoreMatch(b, q) {
    // relevance score for a query token set
    if (!q) return 0;
    const name = b.branch.toLowerCase();
    const city = b.city.toLowerCase();
    const pastor = b.pastor.toLowerCase();
    const region = b.region.toLowerCase();
    let score = 0;
    if (name === q) score += 120;
    if (name.startsWith(q)) score += 60;
    if (name.includes(q)) score += 34;
    if (city.startsWith(q)) score += 30;
    if (city.includes(q)) score += 20;
    if (pastor.includes(q)) score += 24;
    if (region.includes(q)) score += 14;
    if (b._search.includes(q)) score += 6;
    return score;
  }

  function compute() {
    const q = state.query.trim().toLowerCase();
    const f = state.filters;

    let res = ALL.filter((b) => {
      if (f.region && b.region !== f.region) return false;
      if (f.branch && b.branch !== f.branch) return false;
      if (f.pastor && b.pastor !== f.pastor) return false;
      if (f.city && b.city !== f.city) return false;
      if (f.status && b.status !== f.status) return false;
      if (q) {
        const tokens = q.split(/\s+/).filter(Boolean);
        return tokens.every((t) => b._search.includes(t));
      }
      return true;
    });

    // sort
    const s = state.sort;
    if (s === "az") {
      res.sort((a, b) => a.branch.localeCompare(b.branch));
    } else if (s === "region") {
      res.sort((a, b) => a.region.localeCompare(b.region) || a.branch.localeCompare(b.branch));
    } else if (s === "nearest" && state.userLoc) {
      res.sort((a, b) => (a.dist == null ? Infinity : a.dist) - (b.dist == null ? Infinity : b.dist));
    } else {
      // relevance: if searching, by score; else keep source order, but if location known, nearest-ish stays natural
      if (q) {
        res.forEach((b) => (b._score = scoreMatch(b, q)));
        res.sort((a, b) => b._score - a._score || a.branch.localeCompare(b.branch));
      }
    }
    return res;
  }

  /* ---------------------------------------------------------
     4. Rendering — list / cards
  --------------------------------------------------------- */
  const ICONS = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.7-6.5-10.3A6.5 6.5 0 0 1 18.5 10.7C18.5 15.3 12 21 12 21Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="10.3" r="2.3" fill="currentColor"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 4h3l1.4 4-2 1.2a11 11 0 0 0 4.8 4.8l1.2-2 4 1.4v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 6.2 2 2 0 0 1 6.6 4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    directions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11.3 2.7 9.99 9.99a1 1 0 0 1 0 1.42l-7.17 7.17a1 1 0 0 1-1.42 0L2.71 11.3a1 1 0 0 1 0-1.42l7.17-7.17a1 1 0 0 1 1.42 0Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9.5 12.5v-2a1.5 1.5 0 0 1 1.5-1.5h3.5m0 0-2-2m2 2-2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="6" r="2.4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="18" r="2.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="m8.1 10.9 7.8-3.8M8.1 13.1l7.8 3.8" stroke="currentColor" stroke-width="2"/></svg>',
    call: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 4h3l1.4 4-2 1.2a11 11 0 0 0 4.8 4.8l1.2-2 4 1.4v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 6.2 2 2 0 0 1 6.6 4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    church: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4M10 4h4M12 6 5 10v11h14V10l-7-4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 21v-4a2 2 0 0 1 4 0v4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  function highlight(text, q) {
    const safe = escapeHTML(text);
    const query = (q || "").trim();
    if (!query) return safe;
    const tokens = query.split(/\s+/).filter((t) => t.length > 0).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!tokens.length) return safe;
    const re = new RegExp("(" + tokens.join("|") + ")", "gi");
    return safe.replace(re, '<mark class="hl">$1</mark>');
  }

  function directionsHref(b) {
    if (b.hasCoords) return "https://www.google.com/maps/dir/?api=1&destination=" + b.lat + "," + b.lng;
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(b.branch + " " + b.city + " Ghana");
  }
  function branchURL(b) {
    const u = new URL(location.href);
    u.hash = "";
    u.searchParams.set("b", b.id);
    return u.toString();
  }

  function cardHTML(b) {
    const q = state.query;
    const badge = b.status ? `<span class="badge badge-${b.status}">${b.statusLabel}</span>` : "";
    const dist = (b.dist != null) ? `<span class="card-dist">${ICONS.pin}${fmtDist(b.dist)}</span>` : "";
    const pastor = b.pastor
      ? `<span class="card-line">${ICONS.user}<span><b>${highlight(b.pastor, q)}</b></span></span>`
      : `<span class="card-line">${ICONS.user}<span style="color:var(--ink-30)">Pastor — ${UNAVAILABLE}</span></span>`;
    const loc = b.city
      ? `<span class="card-line">${ICONS.pin}<span>${highlight(b.city, q)}</span></span>`
      : "";
    const tel = telHref(b.phone);
    return `
      <article class="branch-card" tabindex="0" role="button" data-id="${b.id}"
               aria-label="View details for ${escapeHTML(b.branch)}">
        <div class="card-top">
          <div>
            <div class="card-title">${highlight(b.branch, q)}</div>
            <div class="card-region">${highlight(b.regionLabel, q)}</div>
          </div>
          ${badge}
        </div>
        <div class="card-meta">
          ${pastor}
          ${loc}
          ${dist}
        </div>
        <div class="card-actions">
          <button class="card-btn primary" data-act="details" data-id="${b.id}">${ICONS.eye}<span>Details</span></button>
          <a class="card-btn" data-act="dir" href="${directionsHref(b)}" target="_blank" rel="noopener" aria-label="Get directions to ${escapeHTML(b.branch)}">${ICONS.directions}<span>Directions</span></a>
          ${tel ? `<a class="card-btn" href="${tel}" aria-label="Call ${escapeHTML(b.branch)}">${ICONS.call}<span>Call</span></a>` : ""}
          <button class="card-btn" data-act="share" data-id="${b.id}" aria-label="Share ${escapeHTML(b.branch)}">${ICONS.share}<span>Share</span></button>
        </div>
      </article>`;
  }

  function renderList() {
    const grid = $("#branch-list");
    const empty = $("#emptyState");
    const loadMore = $("#loadMore");

    if (!CURRENT.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      loadMore.hidden = true;
      grid.setAttribute("aria-busy", "false");
      return;
    }
    empty.hidden = true;
    const slice = CURRENT.slice(0, state.shown);
    grid.innerHTML = slice.map(cardHTML).join("");
    grid.setAttribute("aria-busy", "false");
    loadMore.hidden = CURRENT.length <= state.shown;
    loadMore.textContent = `Show more branches (${CURRENT.length - state.shown} more)`;
  }

  function renderCount() {
    const n = CURRENT.length;
    $("#resultsCount").textContent = n;
    $("#resultsCountLabel").textContent = (n === 1 ? "Branch" : "Branches") + " Found";
    $("#branch-count") && ($("#branch-count").textContent = n + " branches");
  }

  /* ---------------------------------------------------------
     5. Chips (active filters)
  --------------------------------------------------------- */
  const CHIP_KEYS = {
    region: "Region", branch: "Branch", pastor: "Pastor", city: "Location", status: "Status"
  };
  function chipLabel(key, val) {
    if (key === "region") return titleCase(val);
    if (key === "status") return STATUS_META[val] ? STATUS_META[val].label : val;
    return val;
  }
  function renderChips() {
    const row = $("#chipsRow"), box = $("#chips");
    const active = [];
    if (state.query.trim()) active.push(["query", state.query.trim()]);
    Object.keys(state.filters).forEach((k) => { if (state.filters[k]) active.push([k, state.filters[k]]); });

    if (!active.length) { row.hidden = true; box.innerHTML = ""; return; }
    row.hidden = false;
    box.innerHTML = active.map(([k, v]) => {
      const key = k === "query" ? "Search" : CHIP_KEYS[k];
      const label = k === "query" ? v : chipLabel(k, v);
      return `<span class="chip"><span class="chip-key">${key}:</span> ${escapeHTML(label)}
        <button class="chip-x" data-chip="${k}" aria-label="Remove ${key} filter ${escapeHTML(label)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button></span>`;
    }).join("");
  }

  /* ---------------------------------------------------------
     6. Filter dropdowns population
  --------------------------------------------------------- */
  function fillSelect(sel, values, keepFirst) {
    const first = keepFirst ? sel.querySelector("option") : null;
    sel.innerHTML = "";
    if (first) sel.appendChild(first);
    values.forEach((v) => {
      const o = document.createElement("option");
      o.value = v.value; o.textContent = v.label;
      sel.appendChild(o);
    });
  }
  function uniqueSorted(getter, labelFn) {
    const map = new Map();
    ALL.forEach((b) => {
      const v = getter(b);
      if (v) map.set(v, (labelFn ? labelFn(v) : v));
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label }));
  }

  function populateFilters() {
    fillSelect($("#region-filter"), uniqueSorted((b) => b.region, (v) => titleCase(v)), true);
    fillSelect($("#branch-filter"), uniqueSorted((b) => b.branch), true);
    fillSelect($("#pastor-filter"), uniqueSorted((b) => b.pastor), true);
    fillSelect($("#city-filter"), uniqueSorted((b) => b.city), true);
  }

  /* ---------------------------------------------------------
     7. Region explorer
  --------------------------------------------------------- */
  function renderRegions() {
    const counts = new Map();
    ALL.forEach((b) => counts.set(b.region, (counts.get(b.region) || 0) + 1));
    const regions = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const grid = $("#regionGrid");
    grid.innerHTML = regions.map(([r, c]) =>
      `<button class="region-card" role="listitem" data-region="${escapeHTML(r)}" aria-pressed="false">
        <span class="region-name">${titleCase(r)}</span>
        <span class="region-count"><b>${c}</b> ${c === 1 ? "branch" : "branches"}</span>
      </button>`).join("");
  }
  function syncRegionCards() {
    $$(".region-card").forEach((el) => {
      const on = el.dataset.region === state.filters.region;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  /* ---------------------------------------------------------
     8. Stats (+ animated counters)
  --------------------------------------------------------- */
  function computeStats() {
    const regions = new Set(ALL.map((b) => b.region));
    const pastors = new Set(ALL.filter((b) => b.pastor).map((b) => b.pastor.toLowerCase()));
    const cities = new Set(ALL.filter((b) => b.city).map((b) => b.city.toLowerCase()));
    return {
      statBranches: ALL.length,
      statRegions: regions.size,
      statPastors: pastors.size,
      statCities: cities.size
    };
  }
  function animateCount(el, to) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || to === 0) { el.textContent = to; return; }
    const dur = 1100, start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * to);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = to;
    }
    requestAnimationFrame(step);
  }
  function initStats() {
    const stats = computeStats();
    let done = false;
    const run = () => {
      if (done) return; done = true;
      Object.keys(stats).forEach((id) => { const el = $("#" + id); if (el) animateCount(el, stats[id]); });
    };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { run(); io.disconnect(); } });
      }, { threshold: 0.4 });
      io.observe($("#statsGrid"));
    } else { run(); }
  }

  /* ---------------------------------------------------------
     9. Branch details drawer / bottom sheet
  --------------------------------------------------------- */
  let lastFocused = null;
  function detailRow(icon, key, valHTML, muted) {
    return `<div class="detail-row">${icon}<div><div class="detail-k">${key}</div>
      <div class="detail-v ${muted ? "muted" : ""}">${valHTML}</div></div></div>`;
  }
  function openDrawer(id) {
    const b = ALL.find((x) => x.id === id);
    if (!b) return;
    lastFocused = document.activeElement;
    const tel = telHref(b.phone);
    const media = `<div class="dh-media"><div class="dh-fallback">${ICONS.church}</div>` +
      (b.photo ? `<img src="${escapeHTML(b.photo)}" alt="${escapeHTML(b.branch)}" loading="lazy" onerror="this.remove();"/>` : "") +
      `<div class="dh-caption">
        <div class="dh-region">${escapeHTML(b.regionLabel)}</div>
        <h2 id="drawerTitle">${escapeHTML(b.branch)}</h2>
      </div></div>`;

    const distRow = (b.dist != null)
      ? detailRow(ICONS.directions, "Distance from you", fmtDist(b.dist))
      : "";

    $("#drawerBody").innerHTML = `
      ${media}
      <div class="drawer-content">
        ${b.status ? `<div class="drawer-badge"><span class="badge badge-${b.status}">${b.statusLabel}</span></div>` : ""}

        <div class="detail-group">
          <h3>Leadership</h3>
          ${detailRow(ICONS.user, "Pastor / Leader", b.pastor ? escapeHTML(b.pastor) : UNAVAILABLE, !b.pastor)}
        </div>

        <div class="detail-group">
          <h3>Location</h3>
          ${detailRow(ICONS.pin, "Area / City", b.city ? escapeHTML(b.city) : UNAVAILABLE, !b.city)}
          ${detailRow(ICONS.pin, "Region", escapeHTML(b.regionLabel))}
          ${b.address ? detailRow(ICONS.church, "Address", escapeHTML(titleCase(b.address))) : ""}
          ${distRow}
          ${b.hasCoords ? detailRow(ICONS.pin, "Coordinates", `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}`) : ""}
        </div>

        <div class="detail-group">
          <h3>Contact</h3>
          ${detailRow(ICONS.phone, "Phone", `<a href="${tel}">${escapeHTML(b.phone)}</a>`)}
          ${detailRow(ICONS.mail, "Email", `<a href="mailto:${escapeHTML(b.email)}">${escapeHTML(b.email)}</a>`)}
          ${b.year ? detailRow(ICONS.cal, "Established", escapeHTML(b.year)) : ""}
        </div>

        <div class="drawer-actions">
          <a class="card-btn primary full" href="${directionsHref(b)}" target="_blank" rel="noopener">${ICONS.directions}<span>Get Directions</span></a>
          ${tel ? `<a class="card-btn" href="${tel}">${ICONS.call}<span>Call Branch</span></a>` : ""}
          <button class="card-btn" data-act="share" data-id="${b.id}">${ICONS.share}<span>Share</span></button>
        </div>
      </div>`;

    const scrim = $("#drawerScrim"), drawer = $("#drawer");
    scrim.hidden = false; drawer.hidden = false;
    drawer.classList.remove("closing");
    document.body.style.overflow = "hidden";
    // update URL
    setParam("b", b.id);
    requestAnimationFrame(() => { $("#drawerClose").focus(); });
  }
  function closeDrawer() {
    const drawer = $("#drawer"), scrim = $("#drawerScrim");
    if (drawer.hidden) return;
    drawer.classList.add("closing");
    scrim.hidden = true;
    document.body.style.overflow = "";
    setParam("b", null);
    const onEnd = () => {
      drawer.hidden = true; drawer.classList.remove("closing");
      drawer.removeEventListener("animationend", onEnd);
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    };
    drawer.addEventListener("animationend", onEnd);
    // fallback if reduced motion (no animationend)
    setTimeout(() => { if (!drawer.hidden && drawer.classList.contains("closing")) onEnd(); }, 360);
  }
  function trapFocus(e) {
    const drawer = $("#drawer");
    if (drawer.hidden || e.key !== "Tab") return;
    const f = $$('a[href], button:not([disabled]), [tabindex="0"]', drawer);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------------------------------------------------------
     10. Share + toast
  --------------------------------------------------------- */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.innerHTML = ICONS.check + "<span>" + escapeHTML(msg) + "</span>";
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => (t.hidden = true), 320);
    }, 2600);
  }
  async function shareBranch(id) {
    const b = ALL.find((x) => x.id === id);
    if (!b) return;
    const url = branchURL(b);
    const data = {
      title: b.branch + " — Perez Chapel International",
      text: `${b.branch} (${b.regionLabel}) — Perez Chapel International, Ghana`,
      url
    };
    if (navigator.share) {
      try { await navigator.share(data); } catch (err) { /* user cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Branch link copied!");
    } catch (e) {
      // very old browsers
      const ta = document.createElement("textarea");
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Branch link copied!"); }
      catch (_) { toast("Copy this link: " + url); }
      document.body.removeChild(ta);
    }
  }

  /* ---------------------------------------------------------
     11. Map view (lazy)
  --------------------------------------------------------- */
  function statusIcon(status) {
    const color = (STATUS_META[status] || {}).color || "#8a94a6";
    return L.divIcon({
      className: "",
      html: '<svg width="30" height="40" viewBox="0 0 28 36"><path d="M14 0C6.27 0 0 6.27 0 14c0 9.33 14 22 14 22S28 23.33 28 14C28 6.27 21.73 0 14 0z" fill="' + color + '" stroke="white" stroke-width="1.5"/><circle cx="14" cy="14" r="5.5" fill="white"/></svg>',
      iconSize: [30, 40], iconAnchor: [15, 40], popupAnchor: [0, -38]
    });
  }
  function popupHTML(b) {
    const tel = telHref(b.phone);
    return `<div style="min-width:196px">
      <div class="map-pop-title">${escapeHTML(b.branch)}</div>
      <div class="map-pop-region">${escapeHTML(b.regionLabel)}</div>
      <div class="map-pop-line"><strong>Pastor:</strong> ${escapeHTML(b.pastor || UNAVAILABLE)}</div>
      ${b.city ? `<div class="map-pop-line"><strong>Location:</strong> ${escapeHTML(b.city)}</div>` : ""}
      ${b.dist != null ? `<div class="map-pop-line"><strong>${fmtDist(b.dist)}</strong></div>` : ""}
      <button class="map-pop-btn" data-act="details" data-id="${b.id}">View full details</button>
    </div>`;
  }
  function ensureMap() {
    if (mapReady) return;
    map = L.map("map", { scrollWheelZoom: true }).setView(GHANA_CENTER, 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors", maxZoom: 19
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    mapReady = true;
  }
  function renderMap() {
    ensureMap();
    markerLayer.clearLayers();
    const pts = [];
    CURRENT.forEach((b) => {
      if (!b.hasCoords) return;
      const m = L.marker([b.lat, b.lng], { icon: statusIcon(b.status), title: b.branch })
        .bindPopup(popupHTML(b));
      markerLayer.addLayer(m);
      pts.push([b.lat, b.lng]);
    });
    if (pts.length === 1) map.setView(pts[0], 12);
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40] });
    setTimeout(() => map.invalidateSize(), 60);
  }
  function setView(view) {
    state.view = view;
    const isMap = view === "map";
    $("#mapView").hidden = !isMap;
    $("#listView").hidden = isMap;
    $("#tabList").classList.toggle("is-active", !isMap);
    $("#tabMap").classList.toggle("is-active", isMap);
    $("#tabList").setAttribute("aria-selected", String(!isMap));
    $("#tabMap").setAttribute("aria-selected", String(isMap));
    setParam("view", isMap ? "map" : null);
    if (isMap) renderMap();
  }

  /* ---------------------------------------------------------
     12. Near me (geolocation)
  --------------------------------------------------------- */
  function applyDistances() {
    if (!state.userLoc) return;
    const [ulat, ulng] = state.userLoc;
    ALL.forEach((b) => { b.dist = b.hasCoords ? haversine(ulat, ulng, b.lat, b.lng) : null; });
  }
  function nearMe() {
    if (state.geoDenied) { toast("Location is off — search or pick a region instead."); return; }
    if (!("geolocation" in navigator)) { toast("Location isn't supported here — search manually."); return; }
    const btn = $("#nearMeBtn");
    btn.classList.add("locating");
    btn.querySelector("span").textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.userLoc = [pos.coords.latitude, pos.coords.longitude];
        applyDistances();
        // enable nearest sort
        const nearestOpt = $('#sort-select option[value="nearest"]');
        nearestOpt.disabled = false;
        state.sort = "nearest";
        $("#sort-select").value = "nearest";
        btn.classList.remove("locating");
        btn.querySelector("span").textContent = "Sorted by distance";
        setTimeout(() => (btn.querySelector("span").textContent = "Find Branches Near Me"), 3000);
        refresh();
        document.getElementById("results-region").scrollIntoView({ behavior: "smooth", block: "start" });
        toast("Showing branches nearest to you");
      },
      (err) => {
        btn.classList.remove("locating");
        btn.querySelector("span").textContent = "Find Branches Near Me";
        if (err.code === err.PERMISSION_DENIED) {
          state.geoDenied = true;
          toast("Location permission denied — you can search manually.");
        } else {
          toast("Couldn't get your location — please search manually.");
        }
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 }
    );
  }

  /* ---------------------------------------------------------
     13. URL state
  --------------------------------------------------------- */
  function setParam(key, val) {
    const u = new URL(location.href);
    if (val == null || val === "") u.searchParams.delete(key);
    else u.searchParams.set(key, val);
    history.replaceState(null, "", u.toString());
  }
  function syncURLFromState() {
    const u = new URL(location.href);
    const map2 = {
      search: state.query.trim(),
      region: state.filters.region,
      branch: state.filters.branch,
      pastor: state.filters.pastor,
      city: state.filters.city,
      status: state.filters.status,
      sort: state.sort !== "relevance" ? state.sort : ""
    };
    Object.keys(map2).forEach((k) => {
      if (map2[k]) u.searchParams.set(k, map2[k]);
      else u.searchParams.delete(k);
    });
    history.replaceState(null, "", u.toString());
  }
  function readURLIntoState() {
    const p = new URLSearchParams(location.search);
    state.query = p.get("search") || "";
    state.filters.region = p.get("region") || "";
    state.filters.branch = p.get("branch") || "";
    state.filters.pastor = p.get("pastor") || "";
    state.filters.city = p.get("city") || "";
    state.filters.status = p.get("status") || "";
    const sort = p.get("sort");
    if (sort && ["az", "region", "relevance"].includes(sort)) state.sort = sort;
    if (p.get("view") === "map") state.view = "map";
  }

  /* ---------------------------------------------------------
     14. Central refresh
  --------------------------------------------------------- */
  function refresh(resetPage) {
    if (resetPage !== false) state.shown = PAGE_SIZE;
    CURRENT = compute();
    renderCount();
    renderChips();
    syncRegionCards();
    if (state.view === "map" && mapReady) renderMap();
    renderList();
  }

  /* ---------------------------------------------------------
     15. Wire up controls
  --------------------------------------------------------- */
  function reflectStateToControls() {
    $("#search").value = state.query;
    $("#searchClear").hidden = !state.query;
    $("#region-filter").value = state.filters.region;
    $("#branch-filter").value = state.filters.branch;
    $("#pastor-filter").value = state.filters.pastor;
    $("#city-filter").value = state.filters.city;
    $("#status-filter").value = state.filters.status;
    $("#sort-select").value = state.sort;
  }

  function clearAll() {
    state.query = "";
    state.filters = { region: "", branch: "", pastor: "", city: "", status: "" };
    reflectStateToControls();
    hideSuggestions();
    syncURLFromState();
    refresh();
  }

  /* ----- Autocomplete ----- */
  let sugIndex = -1, sugItems = [];
  function buildSuggestions(q) {
    const query = q.toLowerCase().trim();
    if (!query) return [];
    const out = [];
    const seen = new Set();
    const push = (type, label, sub, payload) => {
      const key = type + "|" + label.toLowerCase();
      if (seen.has(key)) return; seen.add(key);
      out.push({ type, label, sub, payload });
    };
    // matching branches (open branch)
    ALL.forEach((b) => {
      if (b.branch.toLowerCase().includes(query)) push("Branch", b.branch, b.regionLabel, { kind: "branch", id: b.id });
    });
    // pastors (filter)
    ALL.forEach((b) => {
      if (b.pastor && b.pastor.toLowerCase().includes(query)) push("Pastor", b.pastor, b.branch, { kind: "pastor", val: b.pastor });
    });
    // cities (filter)
    ALL.forEach((b) => {
      if (b.city && b.city.toLowerCase().includes(query)) push("Location", b.city, b.regionLabel, { kind: "city", val: b.city });
    });
    // regions (filter)
    ALL.forEach((b) => {
      if (b.region.toLowerCase().includes(query)) push("Region", b.regionLabel, "", { kind: "region", val: b.region });
    });
    return out.slice(0, 8);
  }
  function renderSuggestions(items, q) {
    const box = $("#suggestions");
    sugItems = items; sugIndex = -1;
    if (!items.length) { hideSuggestions(); return; }
    box.innerHTML = items.map((it, i) =>
      `<li role="option" id="sug-${i}" aria-selected="false" data-i="${i}">
        <span class="suggestion-ico">${it.type === "Branch" ? ICONS.church : it.type === "Pastor" ? ICONS.user : ICONS.pin}</span>
        <span><span class="suggestion-label">${highlight(it.label, q)}</span>${it.sub ? `<br><span class="suggestion-sub">${escapeHTML(it.sub)}</span>` : ""}</span>
        <span class="suggestion-type">${it.type}</span>
      </li>`).join("");
    box.hidden = false;
    $("#search").setAttribute("aria-expanded", "true");
  }
  function hideSuggestions() {
    const box = $("#suggestions");
    box.hidden = true; box.innerHTML = ""; sugItems = []; sugIndex = -1;
    $("#search").setAttribute("aria-expanded", "false");
    $("#search").removeAttribute("aria-activedescendant");
  }
  function chooseSuggestion(it) {
    hideSuggestions();
    if (it.payload.kind === "branch") {
      openDrawer(it.payload.id);
    } else if (it.payload.kind === "pastor") {
      state.query = ""; state.filters.pastor = it.payload.val;
    } else if (it.payload.kind === "city") {
      state.query = ""; state.filters.city = it.payload.val;
    } else if (it.payload.kind === "region") {
      state.query = ""; state.filters.region = it.payload.val;
    }
    reflectStateToControls();
    syncURLFromState();
    refresh();
  }

  function setup() {
    // year
    $("#year").textContent = new Date().getFullYear();

    // Search input (debounced)
    const doSearch = debounce(() => {
      refresh();
      syncURLFromState();
    }, 200);
    const searchEl = $("#search");
    searchEl.addEventListener("input", (e) => {
      state.query = e.target.value;
      $("#searchClear").hidden = !state.query;
      const items = buildSuggestions(state.query);
      renderSuggestions(items, state.query);
      doSearch();
    });
    searchEl.addEventListener("keydown", (e) => {
      if ($("#suggestions").hidden) {
        if (e.key === "Enter") e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); sugIndex = Math.min(sugItems.length - 1, sugIndex + 1); updateSugActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sugIndex = Math.max(0, sugIndex - 1); updateSugActive(); }
      else if (e.key === "Enter") {
        if (sugIndex >= 0 && sugItems[sugIndex]) { e.preventDefault(); chooseSuggestion(sugItems[sugIndex]); }
        else hideSuggestions();
      } else if (e.key === "Escape") { hideSuggestions(); }
    });
    function updateSugActive() {
      $$("#suggestions li").forEach((li, i) => {
        const on = i === sugIndex;
        li.setAttribute("aria-selected", on ? "true" : "false");
        if (on) { searchEl.setAttribute("aria-activedescendant", "sug-" + i); li.scrollIntoView({ block: "nearest" }); }
      });
    }
    $("#suggestions").addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (li) { e.preventDefault(); chooseSuggestion(sugItems[+li.dataset.i]); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".searchbar")) hideSuggestions();
    });

    $("#searchForm").addEventListener("submit", (e) => e.preventDefault());
    $("#searchClear").addEventListener("click", () => {
      state.query = ""; searchEl.value = ""; $("#searchClear").hidden = true;
      hideSuggestions(); searchEl.focus(); refresh(); syncURLFromState();
    });

    // Filters
    const bind = (id, key) => $(id).addEventListener("change", (e) => {
      state.filters[key] = e.target.value; refresh(); syncURLFromState();
    });
    bind("#region-filter", "region");
    bind("#branch-filter", "branch");
    bind("#pastor-filter", "pastor");
    bind("#city-filter", "city");
    bind("#status-filter", "status");

    // Sort
    $("#sort-select").addEventListener("change", (e) => {
      state.sort = e.target.value; refresh(); syncURLFromState();
    });

    // Chips remove
    $("#chips").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-chip]");
      if (!btn) return;
      const k = btn.dataset.chip;
      if (k === "query") { state.query = ""; }
      else state.filters[k] = "";
      reflectStateToControls(); refresh(); syncURLFromState();
    });
    $("#clearAll").addEventListener("click", clearAll);
    $("#emptyClear").addEventListener("click", clearAll);

    // View toggle
    $("#tabList").addEventListener("click", () => setView("list"));
    $("#tabMap").addEventListener("click", () => setView("map"));

    // Near me
    $("#nearMeBtn").addEventListener("click", nearMe);

    // Region cards
    $("#regionGrid").addEventListener("click", (e) => {
      const card = e.target.closest(".region-card");
      if (!card) return;
      const r = card.dataset.region;
      state.filters.region = state.filters.region === r ? "" : r; // toggle
      reflectStateToControls(); refresh(); syncURLFromState();
      $("#directory").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // Load more
    $("#loadMore").addEventListener("click", () => { state.shown += PAGE_SIZE; renderList(); });

    // Card + drawer + share (event delegation)
    $("#branch-list").addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]");
      if (act) {
        const id = act.dataset.id;
        if (act.dataset.act === "details") { e.preventDefault(); openDrawer(id); }
        else if (act.dataset.act === "share") { e.preventDefault(); shareBranch(id); }
        return; // let directions/call links behave natively
      }
      const card = e.target.closest(".branch-card");
      if (card && !e.target.closest("a") && !e.target.closest("button")) openDrawer(card.dataset.id);
    });
    $("#branch-list").addEventListener("keydown", (e) => {
      const card = e.target.closest(".branch-card");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDrawer(card.dataset.id); }
    });

    // Map popups delegated (details button inside popup)
    document.addEventListener("click", (e) => {
      const act = e.target.closest(".leaflet-popup [data-act]");
      if (act && act.dataset.act === "details") { openDrawer(act.dataset.id); if (map) map.closePopup(); }
    });

    // Drawer share button
    $("#drawerBody").addEventListener("click", (e) => {
      const s = e.target.closest('[data-act="share"]');
      if (s) { e.preventDefault(); shareBranch(s.dataset.id); }
    });

    // Drawer close
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerScrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
      trapFocus(e);
    });

    // Header scroll shrink + nav
    const header = $("#siteHeader");
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking) return; ticking = true;
      requestAnimationFrame(() => { header.classList.toggle("scrolled", window.scrollY > 12); ticking = false; });
    }, { passive: true });

    const navToggle = $("#navToggle"), mobileNav = $("#mobileNav");
    navToggle.addEventListener("click", () => {
      const open = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!open));
      mobileNav.hidden = open;
      mobileNav.dataset.open = String(!open);
    });
    mobileNav.addEventListener("click", (e) => {
      if (e.target.closest("a")) { navToggle.setAttribute("aria-expanded", "false"); mobileNav.hidden = true; mobileNav.dataset.open = "false"; }
    });
  }

  /* ---------------------------------------------------------
     16. Skeletons + boot
  --------------------------------------------------------- */
  function showSkeletons() {
    const sk = $("#skeletonGrid");
    sk.innerHTML = Array.from({ length: 8 }).map(() =>
      `<div class="skeleton-card"><div class="sk title"></div><div class="sk sub"></div><div class="sk line"></div><div class="sk line"></div><div class="sk line short"></div></div>`
    ).join("");
    sk.hidden = false;
  }
  function hideSkeletons() { $("#skeletonGrid").hidden = true; $("#skeletonGrid").innerHTML = ""; }

  function boot(rows) {
    ALL = normalize(rows);
    hideSkeletons();

    populateFilters();
    renderRegions();
    initStats();

    readURLIntoState();
    reflectStateToControls();

    refresh();

    // deep-link: open branch drawer / map view
    const p = new URLSearchParams(location.search);
    if (state.view === "map") setView("map");
    const bid = p.get("b");
    if (bid) { const exists = ALL.find((x) => x.id === bid); if (exists) setTimeout(() => openDrawer(bid), 120); }
  }

  function fail(msg) {
    hideSkeletons();
    const empty = $("#emptyState");
    $("#emptyTitle").textContent = "We couldn't load the directory";
    $("#emptyMsg").textContent = msg || "Please refresh the page to try again.";
    $("#emptyClear").hidden = true;
    empty.hidden = false;
    $("#branch-list").setAttribute("aria-busy", "false");
  }

  document.addEventListener("DOMContentLoaded", () => {
    setup();
    showSkeletons();
    if (typeof Papa === "undefined") { fail("A required library failed to load. Check your connection and refresh."); return; }
    Papa.parse("data/branches.csv", {
      header: true, download: true, skipEmptyLines: true,
      complete: (res) => {
        const rows = (res.data || []).filter((r) => r && r.branch_name);
        if (!rows.length) { fail("No branch records were found."); return; }
        boot(rows);
      },
      error: () => fail("The branch data file could not be loaded.")
    });
  });
})();
