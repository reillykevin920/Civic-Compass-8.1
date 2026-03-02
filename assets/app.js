(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    index: [],
    filter: "ALL",
    categoryFilter: "ALL", // cat-01..cat-10 or ALL
    chunkCache: new Map(),
    dataset: null, // optional data/dataset_manifest.json
    terms: { common: [], synonyms: {} }, // legacy suggestions; kept for UI chips
    categories: [],
    categoriesById: {},
    concepts: [],
    conceptsById: {},
    // Precomputed lookup
    allTerms: [], // [{termNorm, termRaw, conceptId}]
    profile: null,
    expandedGroups: new Set(),
    lastQuery: "",
    lastQueryRaw: "",
    lastActiveTopics: [],
    lastQueryConceptTerms: [],

    // View + pagination (mobile/offline safe)
    view: 'browse',
    search: { pageSize: 50, visible: 50, renderCap: 500, key: '', results: [], top: [] },
    utilSep: { enabled: false, newUtil: 'GAS', existingUtil: 'WATER', orient: 'H', results: [], query: '' },
    drawings: { items: [] },
    reader: { active: false, pageSize: 30, visible: 30, chunk: null, file: '', label: '', fromView: 'search', fromScrollY: 0 },
  };

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\/_]+/g, " ")
      .replace(/[-]+/g, " ")
      .replace(/[^a-z0-9\s\.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setStatus(msg){ $("status").textContent = msg; }

  // Map a record "file" pointer to an actual fetchable path.
  // Datasets define their own folder/prefix mapping in data/dataset_manifest.json.
  function normalizeFilePath(file) {
    const f = String(file || "");
    // Already a full relative path into data
    if (f.startsWith("./data/")) return f;
    // Path includes subfolder (e.g. cfr21/cfr21_ch01.json) — prepend ./data/
    if (f.includes("/")) return `./data/${f}`;
    // Bare filename — return with just data prefix
    return `./data/${f}`;
  }

  // Detect a structured BRC-style section reference like "8-5-12" or "Section 8-5-12".
  // This is distinct from chapter intent and should hard-prefer the actual section record
  // (anchor match) over secondary mentions in other documents.
  function detectSectionQuery(qRaw) {
    const q = String(qRaw || '').trim();
    if (!q) return null;
    // Match common patterns: 8-5-12, 8-5-12., Section 8-5-12, Sec. 8-5-12
    const m = q.match(/\b(?:sec(?:tion)?\.?\s*)?(\d{1,2})-(\d{1,2})-(\d{1,3})\b/i);
    if (!m) return null;
    const section = `${parseInt(m[1],10)}-${parseInt(m[2],10)}-${parseInt(m[3],10)}`;
    return { section, raw: q };
  }

  function sectionAnchorMatch(rec, sectionIntent) {
    if (!sectionIntent) return 0;
    const a = String(rec.anchor || '').trim();
    if (!a) return 0;
    return a === sectionIntent.section ? 1 : 0;
  }


  async function loadIndex() {
    // For large real-world corpora (e.g., CFR), the monolithic cross_corpus_index.json can be tens of MB.
    // Default behavior: do NOT load it at startup. We instead load per-corpus manifests and fetch chapter chunks on-demand.
    state.index = [];
    state.indexMode = "chunked";

    // Best-effort: if a small monolithic index exists and is <= 5MB, we can load it (useful for tiny datasets).
    // This keeps compatibility while staying phone-safe.
    // Intentionally do not probe or load the monolithic index at startup.
// Chunked mode loads per-corpus manifests and chapter chunks on demand.
}

  async function loadInspectorTerms() {
    if ((state.dataset?.tiering || "generic") === "generic") return;
    try {
      const res = await fetch("./data/inspector_terms.json", { cache: "no-store" });
      if (!res.ok) return;
      const t = await res.json();
      if (t && typeof t === "object") {
        state.terms.common = Array.isArray(t.common) ? t.common : [];
        state.terms.synonyms = (t.synonyms && typeof t.synonyms === "object") ? t.synonyms : {};
      }
    } catch (_) {}
  }

  async function loadTechnicalDrawings() {
    if (!state.dataset?.features?.drawingsLibrary) return;
    try {
      const res = await fetch("./data/technical_drawings.json", { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json();
      const items = Array.isArray(payload?.items) ? payload.items : [];
      state.drawings.items = items;
    } catch (_) {
      state.drawings.items = [];
    }
  }

  async function loadCategories() {
    const res = await fetch("./data/categories.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load categories.json");
    const payload = await res.json();
    const cats = Array.isArray(payload?.categories) ? payload.categories : [];
    state.categories = cats;
    state.categoriesById = Object.fromEntries(cats.map(c => [c.id, c]));
  }

  async function loadDatasetManifest() {
    try {
      const res = await fetch("./data/dataset_manifest.json", { cache: "no-store" });
      if (!res.ok) return;
      const m = await res.json();
      if (!m || typeof m !== "object") return;
      // Normalize minimal shape: {appTitle, appSubtitle, tiering, corpora:[{key,label,folder,prefix}]}
      if (Array.isArray(m.corpora)) {
        m.corpora = m.corpora.filter(Boolean).map(c => ({
          key: String(c.key || c.label || "").toUpperCase(),
          label: String(c.label || c.key || ""),
          folder: String(c.folder || String(c.key || "").toLowerCase()),
          prefix: String(c.prefix || (String(c.key || "").toLowerCase() + "_json")),
        })).filter(c => c.key && c.label && c.folder && c.prefix);
      } else {
        m.corpora = [];
      }
      // Filter corpora to only those with a corresponding manifest file.
      // This prevents showing dropdown options (e.g., "Codes") when that corpus isn't present in ./data.
      try {
        const filtered = [];
        for (const c of m.corpora) {
          const manUrl = `./data/${c.folder}_manifest.json`;
          try {
            const head = await fetch(manUrl, { method: "HEAD", cache: "no-store" });
            if (head && head.ok) filtered.push(c);
          } catch (_) { /* ignore */ }
        }
        m.corpora = filtered;
      } catch (_) { /* ignore */ }

      const branding = (m.branding && typeof m.branding === "object") ? m.branding : {};
      const productName = String(branding.productName || m.appTitle || "Corpa Compass").trim() || "Corpa Compass";
      const org = String(branding.organization || "").trim();
      const dept = String(branding.department || "").trim();
      const datasetLabel = String(branding.datasetLabel || "").trim();
      const subtitleOverride = String(branding.subtitle || m.appSubtitle || "").trim();
      const subtitle = subtitleOverride || [org, dept].filter(Boolean).join(" — ") || datasetLabel || productName || "Corpa Compass";
      state.dataset = {
        appTitle: productName,
        appSubtitle: subtitle,
        branding: {
          productName,
          organization: org,
          department: dept,
          datasetLabel,
          subtitle
        },
        tiering: String(m.tiering || "generic"),
        corpora: m.corpora,
        features: (m.features && typeof m.features === "object") ? m.features : {},
      };
    } catch (_) { /* ignore */ }
  }

  function applyDatasetBranding() {
    if (!state.dataset) return;
    const t = document.getElementById("appTitle");
    if (t && state.dataset.appTitle) t.textContent = state.dataset.appTitle;
    const s = document.getElementById("appSubtitle");
    if (s && state.dataset.appSubtitle) s.textContent = state.dataset.appSubtitle;
    const f = document.getElementById("footerName");
    if (f && state.dataset.appTitle) f.textContent = state.dataset.appTitle;
    document.title = state.dataset.appTitle ? (state.dataset.appTitle + " • " + (state.dataset.appSubtitle || "")) : document.title;
  }

  function populateCorpusSelect() {
    const sel = document.getElementById("corpusSelect");
    if (!sel) return;
    // preserve existing ALL
    const keep = new Set(["ALL"]);
    // remove everything but ALL
    [...sel.options].forEach(o => { if (!keep.has(o.value)) sel.removeChild(o); });
    const corpora = (state.dataset && Array.isArray(state.dataset.corpora) && state.dataset.corpora.length)
      ? state.dataset.corpora
      : [];
    for (const c of corpora) {
      const opt = document.createElement("option");
      opt.value = String(c.key || "").toUpperCase();
      opt.textContent = String(c.label || c.key || opt.value);
      sel.appendChild(opt);
    }
  }

  function applyDatasetFeatureToggles() {
    // Hide ROW-specific panels unless explicitly enabled by dataset_manifest.json.
    const f = (state.dataset && state.dataset.features) ? state.dataset.features : {};
    const showSeparations = !!f.utilitySeparations;
    const showRestoration = !!f.restorationMode;
    const showDrawings = ((state.drawings && Array.isArray(state.drawings.items) && state.drawings.items.length) ? true : false) || !!f.drawingsLibrary;

    const sep = document.getElementById("separationsPanel");
    const rest = document.getElementById("restorationPanel");
    const draw = document.getElementById("techDrawings");

    if (sep) sep.style.display = showSeparations ? "" : "none";
    if (rest) rest.style.display = showRestoration ? "" : "none";
    if (draw) draw.style.display = showDrawings ? "" : "none";
  }


  function buildConceptTermIndex() {
    const all = [];
    for (const c of state.concepts) {
      const terms = Array.isArray(c.terms) ? c.terms : [];
      const normed = [];
      for (const t of terms) {
        const raw = String(t || "").trim();
        if (!raw) continue;
        const tn = norm(raw);
        if (!tn) continue;
        normed.push(tn);
        all.push({ termNorm: tn, termRaw: raw, conceptId: c.conceptId });
      }
      // longest-first helps phrase matching
      c._termNorms = Array.from(new Set(normed)).sort((a,b)=>b.length-a.length);
    }
    // longest-first global term scan
    state.allTerms = all.sort((a,b)=>b.termNorm.length-a.termNorm.length);

    // Maps for concept-term coverage
    state.conceptTermsNormById = {};
    state.termNormToConceptIds = {};
    for (const c of state.concepts) {
      state.conceptTermsNormById[c.conceptId] = new Set(c._termNorms || []);
    }
    for (const t of state.allTerms) {
      if (!t || !t.termNorm) continue;
      if (!state.termNormToConceptIds[t.termNorm]) state.termNormToConceptIds[t.termNorm] = new Set();
      state.termNormToConceptIds[t.termNorm].add(t.conceptId);
    }
  }

  async function loadCorpusManifest(folder) {
    // Expects ./data/<folder>_manifest.json with shape: { chapters: [{chapter, file, records, sha256}] }
    try {
      const res = await fetch(`./data/${folder}_manifest.json`, { cache: "no-store" });
      if (!res.ok) return null;
      const m = await res.json();
      if (!m || !Array.isArray(m.chapters)) return null;
      return {
        folder,
        chapters: m.chapters.filter(Boolean).map(ch => ({
          chapter: String(ch.chapter || ""),
          file: String(ch.file || ""),
          records: Number(ch.records || 0)
        })).filter(ch => ch.file)
      };
    } catch (_) {
      return null;
    }
  }

  async function ensureChunkPlan() {
    if (state.chunkPlan && state.chunkPlan.length) return;
    state.chunkPlan = [];
    if (!state.dataset || !Array.isArray(state.dataset.corpora)) return;

    for (const c of state.dataset.corpora) {
      const folder = String(c.folder || "").trim();
      if (!folder) continue;
      const man = await loadCorpusManifest(folder);
      if (!man) continue;
      state.chunkPlan.push({
        key: String(c.key || "").toUpperCase(),
        label: String(c.label || c.key || folder),
        folder,
        chapters: man.chapters
      });
    }
  }

  function chunkKey(folder, file) {
    return `${folder}/${file}`;
  }

  async function fetchChunk(folder, file, signal) {
    const k = chunkKey(folder, file);
    if (state.chunkCache.has(k)) return state.chunkCache.get(k);

    const res = await fetch(`./data/${folder}/${file}`, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`Missing chunk: ${folder}/${file}`);
    const payload = await res.json();

    const recs = Array.isArray(payload) ? payload : (Array.isArray(payload?.records) ? payload.records : []);
    // annotate concepts/categories on the fly
    for (const r of recs) {
      try { matchConceptsForRecord(r); } catch (_) {}
    }

    state.chunkCache.set(k, recs);
    return recs;
  }

  async function runSearchChunked(qRaw, q) {
    await ensureChunkPlan();

    // Abort any prior chunked search
    if (state.searchAbort) {
      try { state.searchAbort.abort(); } catch (_) {}
    }
    state.searchAbort = new AbortController();
    const { signal } = state.searchAbort;

    setStatus("Searching (streaming chunks)…");
    $('count').textContent = '…';
    setView('search');
    $('results').innerHTML = `<div class="card"><div class="snip">Searching… (loading chunks as needed)</div></div>`;

    const sectionIntent = detectSectionQuery(q);
    const intents = detectIntents(q);
    const qConcept = detectQueryConcepts(q);
    state.lastQueryConceptTerms = (qConcept.matches || []).map(m => m.termRaw);
    state.lastActiveTopics = intents.topics;

    const canIncludeInFiltered = (rec) => {
      if (!state.categoryFilter || state.categoryFilter === 'ALL') return true;
      return String(rec._primaryCategoryId || '') === String(state.categoryFilter);
    };

    const results = [];
    let scanned = 0;

    // limit to keep UI responsive
    const HARD_LIMIT = 400;

    const eligibleCorpora = (state.chunkPlan || []).filter(cp => {
      if (!state.filter || state.filter === 'ALL') return true;
      return String(cp.key) === String(state.filter);
    });

    for (const cp of eligibleCorpora) {
      for (const ch of cp.chapters) {
        if (signal.aborted) return;

        // yield occasionally to avoid freezing UI
        await new Promise(r => setTimeout(r, 0));

        let recs = [];
        try {
          recs = await fetchChunk(cp.folder, ch.file, signal);
        } catch (e) {
          continue;
        }

        for (const rec of recs) {
          scanned++;

          const includeFiltered = canIncludeInFiltered(rec);

          // Section intent (exact anchor match) — hard prefer
          if (sectionIntent && sectionAnchorMatch(rec, sectionIntent)) {
            rec._tier = 9999;
            const score = 1e9;
            results.push({ rec, score, includeFiltered });
            continue;
          }

          const score = scoreRecord(rec, q, intents, qConcept);
          if (score <= 0) continue;

          results.push({ rec, score, includeFiltered });

          if (results.length >= HARD_LIMIT) break;
        }

        if (results.length >= HARD_LIMIT) break;

        // Update progress occasionally
        if (scanned % 1500 === 0) {
          setStatus(`Searching… scanned ${scanned.toLocaleString()} records`);
        }
      }
      if (results.length >= HARD_LIMIT) break;
    }

    // Sort and split like original logic
    results.sort((a, b) => b.score - a.score);

    const scoredAllCats = [];
    const scoredFiltered = [];

    for (const x of results) {
      x.rec._score = x.score || 0;
      x.rec._exact = (x.score >= 1e9) ? 1 : 0;
      scoredAllCats.push(x.rec);
      if (x.includeFiltered) scoredFiltered.push(x.rec);
    }

    state.search.top = scoredFiltered.slice(0, Math.min(50, scoredFiltered.length));
    state.search.results = scoredAllCats;

    $('count').textContent = String(scoredFiltered.length);
    setStatus(`Search complete (${scoredFiltered.length.toLocaleString()} hits, streamed)`);

    renderSearchResults();
  }

  async function loadConcepts() {
    const res = await fetch("./data/concepts.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load concepts.json");
    const payload = await res.json();
    const concepts = Array.isArray(payload?.concepts) ? payload.concepts : [];
    state.concepts = concepts;
    state.conceptsById = Object.fromEntries(concepts.map(c => [c.conceptId, c]));
    buildConceptTermIndex();
  }

  function matchConceptsForRecord(rec) {
    const heading = String(rec.heading || "");
    const hayRaw = `${rec.anchor || ""} ${heading} ${rec.text || rec.snippet || rec.verbatim || ""}`;
    const hay = norm(hayRaw);
    const head = norm(heading);

    let best = null; // {conceptId, score}
    const hits = new Set();

    // Scan concepts with their own term lists (bounded; fast enough for ~2.6k records)
    for (const c of state.concepts) {
      const termNorms = c._termNorms || [];
      let localBestLen = 0;
      let inHeading = false;
      for (const tn of termNorms) {
        if (!tn) continue;
        if (head && head.includes(tn)) {
          inHeading = true;
          localBestLen = max(localBestLen, tn.length);
          break;
        }
        if (hay.includes(tn)) {
          localBestLen = max(localBestLen, tn.length);
          // keep scanning in case a longer term exists
        }
      }
      if (localBestLen > 0) {
        hits.add(c.conceptId);
        const score = (inHeading ? 1000 : 0) + localBestLen;
        if (!best || score > best.score) best = { conceptId: c.conceptId, score };
      }
    }

    rec._concepts = Array.from(hits);
    const bestConcept = best ? state.conceptsById[best.conceptId] : null;
    rec._primaryCategoryId = bestConcept?.primaryCategoryId || "";
  }

  function max(a,b){ return a>b?a:b; }

  function annotateIndex() {
    for (const rec of state.index) matchConceptsForRecord(rec);
  }

  async function loadInspectorProfile() {
    if ((state.dataset?.tiering || "generic") === "generic") return;
    try {
      const res = await fetch("./data/inspector_profile.json", { cache: "no-store" });
      if (!res.ok) return;
      const p = await res.json();
      if (p && typeof p === "object") state.profile = p;
    } catch (_) {}
  }

  function buildSuggestionsUI() {
    const dl = document.getElementById("suggestions");
    if (dl) {
      dl.innerHTML = "";
      const seen = new Set();
      for (const s of state.terms.common) {
        const v = String(s || "").trim();
        if (!v) continue;
        const k = v.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        const opt = document.createElement("option");
        opt.value = v;
        dl.appendChild(opt);
      }
    }

    const chips = document.getElementById("chips");
    if (chips) {
      chips.innerHTML = "";
      for (const s of state.terms.common.slice(0, 12)) {
        const v = String(s || "").trim();
        if (!v) continue;
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.textContent = v;
        b.addEventListener("click", () => {
          $("q").value = v;
          runSearch();
          $("q").focus();
        });
        chips.appendChild(b);
      }
    }
  }

  function setActiveFilter(corpus) {
    state.filter = corpus;
    document.querySelectorAll(".filter").forEach(b => {
      b.classList.toggle("active", b.dataset.corpus === corpus);
    });
    runSearch();
  }

  function getQuery() {
    return $("q").value.trim().toLowerCase();
  }

  // Minimal, deterministic query expansion for legacy terminology.
  // Requirement: searching for "fiber" must yield telecom results (older code language).
  function expandQuery(qRaw) {
    const q = String(qRaw || '').trim().toLowerCase();
    if (!q) return '';
    const hasFiber = /\bfiber\b/.test(q) || /\bfibre\b/.test(q);
    const hasTele = /\btelecom\b/.test(q) || /\btelecommunication\b/.test(q) || /\bcommunications\b/.test(q);
    if (hasFiber && !hasTele) return `${q} telecom`;
    return q;
  }

  function chapterMatch(rec, n){
    if (!n) return false;
    const corpus = String(rec.corpus||'').toUpperCase();
    if (corpus === 'DCS') return Number(rec.path?.chapter) === n;
    if (corpus === 'TITLE9' || corpus === 'TITLE 9') return Number(rec.path?.chapter) === n;
    return false;
  }

  function readerContextLabel(rec){
    const corpus = String(rec.corpus||'');
    if (corpus === 'DCS') return `DCS — Chapter ${rec.path?.chapter ?? ''}`;
    if (corpus === 'BRC') return `BRC — Title ${String(rec.path?.title ?? '').padStart(2,'0')}`;
    if (corpus === 'TITLE9') return `Title 9 — Chapter ${rec.path?.chapter ?? ''}`;
    return corpus || 'Reader';
  }

  function setView(v){
    state.view = v;
  }

  function detectQueryConcepts(q) {
    const qn = norm(q);
    const bestByConcept = new Map(); // conceptId -> {len, termRaw, termNorm}
    if (!qn) return { concepts: [], matches: [] };

    // longest-first scan; stop early when term is longer than remaining? (keep simple)
    for (const t of state.allTerms) {
      if (!t?.termNorm) continue;
      if (!qn.includes(t.termNorm)) continue;
      const prev = bestByConcept.get(t.conceptId);
      if (!prev || t.termNorm.length > prev.len) {
        bestByConcept.set(t.conceptId, { len: t.termNorm.length, termRaw: t.termRaw, termNorm: t.termNorm });
      }
    }

    const matches = Array.from(bestByConcept.entries()).map(([conceptId, info]) => ({ conceptId, ...info }));
    matches.sort((a,b)=>b.len-a.len);
    return { concepts: matches.map(m=>m.conceptId), matches };
  }

  function tokensFromQuery(q) {
    const raw = String(q || "").toLowerCase();
    const stop = new Set((state.profile?.stopwords || []).map(s => String(s).toLowerCase()));
    return raw
      .split(/\s+/)
      .map(t => t.replace(/[^a-z0-9\-\.\(\)]+/g, "").trim())
      .filter(t => t && !stop.has(t));
  }

  function detectIntents(q) {
    const raw = String(q || "").toLowerCase();
    const ik = state.profile?.intent_keywords || {};
    const topics = [];
    for (const [topic, kws] of Object.entries(ik)) {
      if (!Array.isArray(kws)) continue;
      if (kws.some(k => k && raw.includes(String(k).toLowerCase()))) topics.push(topic);
    }
    return { topics };
  }

  function classifySurface(hay) {
    const sk = state.profile?.surface_keywords || {};
    const h = String(hay || "").toLowerCase();
    for (const [label, arr] of Object.entries(sk)) {
      for (const k of (arr || [])) {
        if (k && h.includes(String(k).toLowerCase())) return label;
      }
    }
    return "";
  }

  function classifyPhase(hay) {
    const pk = state.profile?.phase_keywords || {};
    const h = String(hay || "").toLowerCase();
    for (const [label, arr] of Object.entries(pk)) {
      for (const k of (arr || [])) {
        if (k && h.includes(String(k).toLowerCase())) return label;
      }
    }
    return "";
  }

  function tagRecord(rec) {
    const hay = `${rec.heading || ""} ${rec.text || ""} ${rec.snippet || ""} ${rec.anchor || ""}`.toLowerCase();
    const tags = [];

    // Core ROW buckets
    if (/(restore|restoration|patch|patching|repair|replac|sawcut|backfill|compaction)/.test(hay)) tags.push("Restoration");
    if (/(traffic control|tcmp|mutcd|barricade|cone|detour|flagger|lane closure)/.test(hay)) tags.push("Traffic Control");
    if (/(permit|right-of-way|\brow\b|license|authorization)/.test(hay)) tags.push("Permitting");

    // Utilities (use conservative cues; boosts happen via intent gates)
    if (/(telecommunication|telecommunications|\btelecom\b|communications|fiber optic|conduit|duct|handhole|pull box|vault|splice)/.test(hay)) tags.push("Utilities — Telecom/Fiber");
    if (/(\belectric\b|electrical|power|transformer|pedestal)/.test(hay)) tags.push("Utilities — Electric");
    if (/(\bgas\b|gas main|gas service|meter|regulator)/.test(hay)) tags.push("Utilities — Gas");
    if (/(\bwater\b|water main|hydrant|valve|service line|backflow)/.test(hay)) tags.push("Utilities — Water");
    if (/(\bsewer\b|sanitary|manhole|lateral)/.test(hay)) tags.push("Utilities — Sewer");
    if (/(stormwater|\bstorm\b|inlet|catch basin|culvert|drain|outfall)/.test(hay)) tags.push("Utilities — Storm");

    // Bikes
    if (/(\bbike\b|bicycle|bike lane|bikeway|pavement marking|striping)/.test(hay)) tags.push("Bikes");

    // CRM-ish maintenance
    if (/(encroachment|obstruction|overgrown|vegetation|hedge|sight distance|visibility|sidewalk obstruction)/.test(hay)) tags.push("Maintenance/CRM");

    const surface = classifySurface(hay);
    if (surface) tags.push(surface);

    const phase = classifyPhase(hay);
    if (phase) tags.push(phase);

    return tags;
  }


  
  function scoreRecord(rec, qRaw, intents, qConcept, opts) {
    // Generic scoring: exact matches first, then closest matches.
    if (state.filter !== "ALL" && rec.corpus !== state.filter) return null;
    const q = String(qRaw || "").trim();
    if (!q) return null;

    const anchor = String(rec.anchor || "");
    const heading = String(rec.heading || "");
    const text = String(rec.text || rec.snippet || rec.verbatim || "");

    const hay = `${anchor}\n${heading}\n${text}`;
    const hayLower = hay.toLowerCase();
    const qLower = q.toLowerCase();

    // 1) Exact anchor match (e.g., "8-5-12" or "Section 8-5-12")
    const secIntent = detectSectionQuery(q);
    const anchorExact = (secIntent && String(anchor).trim() === secIntent.section) ? 1 : 0;

    // 2) Exact phrase match (normalized)
    const qNorm = norm(q);
    const hayNorm = norm(hay);
    const phraseHit = (qNorm.length >= 2 && hayNorm.includes(qNorm)) ? 1 : 0;

    // 3) Token coverage
    const tokens = qNorm.split(" ").filter(Boolean);
    let tokenHits = 0;
    for (const t of tokens) if (t && hayNorm.includes(t)) tokenHits++;

    const coverage = tokens.length ? (tokenHits / tokens.length) : 0;

    // 4) Field boosts (anchor/heading more important than body)
    const headingHit = heading.toLowerCase().includes(qLower) ? 1 : 0;
    const anchorHit = anchor.toLowerCase().includes(qLower) ? 1 : 0;

    // Corpus priority: if dataset manifest specifies order, earlier corpora get a small tie-break boost.
    let corpusBoost = 0;
    if (state.dataset && Array.isArray(state.dataset.corpora)) {
      const idx = state.dataset.corpora.findIndex(c => c && c.id === rec.corpus);
      if (idx >= 0) corpusBoost = Math.max(0, 0.02 * (state.dataset.corpora.length - idx));
    }

    // Final score: exact anchor > exact phrase > coverage
    const score =
      (anchorExact ? 1000 : 0) +
      (phraseHit ? 500 : 0) +
      (headingHit ? 40 : 0) +
      (anchorHit ? 25 : 0) +
      Math.round(100 * coverage) +
      corpusBoost;

    // Require some evidence
    if (!anchorExact && !phraseHit && coverage < 0.5) return null;

    return { score, anchorExact, phraseHit, coverage };
  }

  function groupKey(rec, activeTopics) {
    const catId = rec._primaryCategoryId || "";
    const catLabel = (state.categoriesById[catId]?.label) || "Other";
    // UI contract: display categories by label only (no IDs like cat-01).
    let lead = `${catLabel}`;

    if (rec.corpus === "DCS") {
      const ch = rec.path?.chapter ?? "";
      return `${lead} • DCS — Chapter ${ch}`;
    }
    if (rec.corpus === "BRC") {
      const t = rec.path?.title ?? "";
      return `${lead} • BRC — Title ${String(t).padStart(2,"0")}`;
    }
    if (rec.corpus === "TITLE9") {
      const ch = rec.path?.chapter ?? "";
      return `${lead} • Title 9 — Chapter ${ch}`;
    }
    return `${lead} • ${rec.corpus}`;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"]/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  }

  function escapeRegExp(s){
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightSnippetHtml(snippet, query){
    const snip = String(snippet || "");
    const qRaw = String(query || "").trim();
    if (!snip || !qRaw) return escapeHtml(snip);

    // Terms: full query (if meaningful) + tokens (>=3 chars). Longest-first.
    const terms = [];
    const qNorm = qRaw.toLowerCase();
    if (qNorm.length >= 3) terms.push(qNorm);
    for (const t of qNorm.split(/\s+/)) {
      const v = t.replace(/[^a-z0-9\-]+/g, "").trim();
      if (v && v.length >= 3) terms.push(v);
    }
    const uniq = Array.from(new Set(terms)).sort((a,b)=>b.length-a.length);
    if (!uniq.length) return escapeHtml(snip);

    const pattern = uniq.map(escapeRegExp).join("|");
    const re = new RegExp(`(${pattern})`, "gi");

    // Sentinel wrapping prevents HTML injection issues.
    const OPEN = "\u0000HIT_OPEN\u0000";
    const CLOSE = "\u0000HIT_CLOSE\u0000";
    const marked = snip.replace(re, `${OPEN}$1${CLOSE}`);
    const escaped = escapeHtml(marked);
    return escaped
      .replaceAll(OPEN, '<span class="hit">')
      .replaceAll(CLOSE, '</span>');
  }

  function buildSnippet(fullText, query, matchTerms) {
    const MAX = 375;
    const HALF = Math.floor(MAX / 2);

    const text = String(fullText || "");
    if (!text) return "";

    const lower = text.toLowerCase();
    const q = String(query || "").toLowerCase().trim();

    const candidates = [];
    // Prefer matched concept phrases (multiword) first
    if (Array.isArray(matchTerms)) {
      for (const t of matchTerms) {
        const v = String(t || "").toLowerCase().trim();
        if (v && v.length >= 4) candidates.push(v);
      }
    }
    if (q && q.length >= 4) {
      candidates.push(q);
      candidates.push(q.replace(/-/g, " "));
    }

    // Fall back to tokens
    for (const tok of q.split(/\s+/)) {
      const t = tok.replace(/[^a-z0-9\-]+/g, "").trim();
      if (t && t.length >= 3) candidates.push(t);
    }

    let idx = -1;
    let hitLen = 0;
    for (const c of candidates) {
      const pos = lower.indexOf(c);
      if (pos >= 0) { idx = pos; hitLen = c.length; break; }
    }

    if (idx < 0) {
      // No hit found; return leading snippet capped.
      return text.replace(/\s+/g, " ").trim().slice(0, MAX);
    }

    const center = idx + Math.floor(hitLen / 2);
    let start = Math.max(0, center - HALF);
    let end = Math.min(text.length, start + MAX);
    start = Math.max(0, end - MAX);

    let snip = text.slice(start, end).replace(/\s+/g, " ").trim();

    if (start > 0) snip = "…" + snip;
    if (end < text.length) snip = snip + "…";
    return snip;
  }


  function buildResultCard(rec, catLabel, queryOverride, conceptTermsOverride){
    const card = document.createElement('div');
    card.className = 'card';

    const top = document.createElement('div');
    top.className = 'card-top';

    const left = document.createElement('div');
    const badges = document.createElement('div');
    badges.className = 'badges';

    const catBadge = `<span class="badge badge-soft">${escapeHtml(catLabel)}</span>`;

    const location = (() => {
      if (rec.corpus === 'DCS') {
        const ch = rec.path?.chapter ?? '';
        return `DCS Ch ${ch}`;
      }
      if (rec.corpus === 'BRC') {
        const t = rec.path?.title ?? '';
        return `BRC Title ${String(t).padStart(2,'0')}`;
      }
      if (rec.corpus === 'TITLE9') {
        const ch = rec.path?.chapter ?? '';
        return `Title 9 Ch ${ch}`;
      }
      return rec.corpus;
    })();

    badges.innerHTML = `${catBadge}
      <span class="badge"><strong>${escapeHtml(rec.corpus)}</strong></span>
      <span class="badge">${escapeHtml(location)}</span>
      <span class="badge">Anchor: <strong>${escapeHtml(rec.anchor)}</strong></span>`;
    left.appendChild(badges);

    const heading = document.createElement('div');
    heading.className = 'heading';
    heading.textContent = rec.heading || '(No heading)';
    left.appendChild(heading);

    const snip = document.createElement('p');
    snip.className = 'snip';
    const q = (queryOverride !== undefined && queryOverride !== null) ? String(queryOverride) : (state.lastQuery || '');
    const terms = Array.isArray(conceptTermsOverride) ? conceptTermsOverride : state.lastQueryConceptTerms;
    const snippetText = buildSnippet(rec.text || rec.snippet || rec.verbatim || '', q, terms);
    snip.innerHTML = highlightSnippetHtml(snippetText, q);
    left.appendChild(snip);

    top.appendChild(left);
    card.appendChild(top);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Show code';
    btn.addEventListener('click', () => toggleVerbatim(card, rec, btn));
    actions.appendChild(btn);

    // Read-through mode (per chapter/title)
    const readLabel = (rec.corpus === 'BRC') ? 'Read title' : 'Read chapter';
    const readBtn = document.createElement('button');
    readBtn.className = 'btn';
    readBtn.type = 'button';
    readBtn.textContent = readLabel;
    readBtn.addEventListener('click', () => openReaderForRecord(rec));
    actions.appendChild(readBtn);

    card.appendChild(actions);
    return card;
  }

  function renderResultsInto(container, list, opts = {}) {
    if (!opts.skipCount) $("count").textContent = list.length.toLocaleString();

    if (!list.length) {
      const emptyCard = document.createElement('div');
      emptyCard.className = 'card';
      emptyCard.innerHTML = '<div class="snip">No results.</div>';
      if (opts.appendOnEmpty) container.appendChild(emptyCard);
      else container.innerHTML = emptyCard.outerHTML;
      return;
    }

    // Build category buckets (collapsed by default) for scroll navigation.
    const buckets = new Map(); // catId -> recs[]
    for (const rec of list) {
      const catId = (rec._primaryCategoryId && state.categoriesById[rec._primaryCategoryId])
        ? rec._primaryCategoryId
        : 'OTHER';
      if (!buckets.has(catId)) buckets.set(catId, []);
      buckets.get(catId).push(rec);
    }

    // Order categories:
    //  - Browse mode (no query): workflow order (categories.json)
    //  - Search mode (query present): relevance order (highest relevance category first)
    //    and hide empty categories entirely.
    let orderedCatIds = [];
    const queryActive = Boolean((state.lastQuery || '').trim());

    if (queryActive) {
      // Derive per-category relevance from the full scored result set when available.
      // This avoids category-window ordering being dominated by the default workflow list.
      const full = Array.isArray(state.search?.results) && state.search.results.length
        ? state.search.results
        : list;
      orderedCatIds = computeCategoryOrderFromResults(full, { hideEmpty: true });
      // Preserve OTHER at the end if it exists and has results.
      if (buckets.has('OTHER') && !orderedCatIds.includes('OTHER')) orderedCatIds.push('OTHER');
    } else {
      for (const c of state.categories) orderedCatIds.push(c.id);
      if (buckets.has('OTHER')) orderedCatIds.push('OTHER');
    }

    const perCatDefault = (opts.perCatDefault ?? 20);

    for (const catId of orderedCatIds) {
      const recs = buckets.get(catId);
      if (!recs || !recs.length) continue;

      // Respect dropdown selection by hiding non-matching buckets in UI
      // (Top matches explicitly bypasses this; category windows do not.)
      if (!opts.ignoreCategoryFilter) {
        if (state.categoryFilter && state.categoryFilter !== 'ALL' && catId !== state.categoryFilter) continue;
      }

      // Within-category ordering during search should respect exactness first.
      // (Exact phrase/anchor matches must surface above hierarchy.)
      recs.sort((a,b)=>{
        const ea = (a._exact || 0);
        const eb = (b._exact || 0);
        if (ea !== eb) return eb - ea;
        const sa = (a._score || 0);
        const sb = (b._score || 0);
        if (sa !== sb) return sb - sa;
        return 0;
      });

      const label = (catId === 'OTHER')
        ? 'Other'
        : (state.categoriesById[catId]?.label || 'Other');

      const details = document.createElement('details');
      details.className = 'catgroup';
      // collapsed on landing; if user selected a specific category, open it.
      if (state.categoryFilter && state.categoryFilter !== 'ALL') details.open = true;

      const summary = document.createElement('summary');
      summary.className = 'catgroup-summary';
      summary.innerHTML = `<span class="catgroup-title">${escapeHtml(label)}</span><span class="catgroup-count">${recs.length}</span>`;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'catgroup-body';

      const expandedKey = `cat:${catId}`;
      const expanded = state.expandedGroups.has(expandedKey);
      const showN = expanded ? recs.length : Math.min(perCatDefault, recs.length);

      for (const rec of recs.slice(0, showN)) {
        body.appendChild(buildResultCard(rec, label));
      }

      if (recs.length > perCatDefault) {
        const moreWrap = document.createElement('div');
        moreWrap.className = 'actions';
        const more = document.createElement('button');
        more.className = 'btn';
        more.textContent = expanded ? 'Show fewer' : `Show more (${recs.length - perCatDefault})`;
        more.addEventListener('click', () => {
          if (state.expandedGroups.has(expandedKey)) state.expandedGroups.delete(expandedKey);
          else state.expandedGroups.add(expandedKey);
          if (state.view === 'search') renderSearchResults();
          else renderResults(list);
        });
        moreWrap.appendChild(more);
        body.appendChild(moreWrap);
      }

      details.appendChild(body);
      container.appendChild(details);
    }
  }

  function renderResults(list, opts = {}) {
    const container = $("results");
    container.innerHTML = "";
    renderResultsInto(container, list, opts);
  }

  async function fetchJsonWithFallbacks(path) {
    // GitHub Pages + SW caching can be finicky when repos are served from a subpath.
    // Try a small set of safe fallbacks before failing.
    const candidates = [];
    const p = String(path || "");
    if (p) candidates.push(p);
    if (p.startsWith("./")) candidates.push(p.slice(2));
    else candidates.push(`./${p}`);

    // Also try resolving relative to the current directory explicitly
    try {
      const url = new URL(p, window.location.href).toString();
      candidates.push(url);
    } catch (_) {}

    const seen = new Set();
    for (const c of candidates) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      const res = await fetch(c, { cache: "no-store" });
      if (res.ok) return { url: c, data: await res.json() };
      // Keep going on 404/500 to try other candidates
    }
    throw new Error(`Failed to load chunk: ${path}`);
  }



  function renderBrowse() {
    const container = $("results");
    container.innerHTML = "";

    const buckets = new Map(); // catId -> recs
    for (const rec of state.index) {
      if (state.filter !== 'ALL' && rec.corpus !== state.filter) continue;
      const catId = (rec._primaryCategoryId && state.categoriesById[rec._primaryCategoryId]) ? rec._primaryCategoryId : 'OTHER';
      if (!buckets.has(catId)) buckets.set(catId, []);
      buckets.get(catId).push(rec);
    }

    const orderedCatIds = [];
    for (const c of state.categories) orderedCatIds.push(c.id);
    if (buckets.has('OTHER')) orderedCatIds.push('OTHER');

    const perCatDefault = 25;
    let total = 0;

    for (const catId of orderedCatIds) {
      if (state.categoryFilter && state.categoryFilter !== 'ALL' && catId !== state.categoryFilter) continue;
      const recs = buckets.get(catId);
      if (!recs || !recs.length) continue;

      const corpusRank = (c) => {
        const cc = String(c || '').toUpperCase();
        if (cc === 'DCS') return 0;
        if (cc === 'TITLE9' || cc === 'TITLE 9') return 1;
        if (cc === 'BRC') return 2;
        return 3;
      };

      // Browse mode should not look "BRC-only" due to alphabetical truncation.
      // Sort by tier/corpus/location first, then heading.
      recs.sort((a,b) => {
        const ra = corpusRank(a.corpus);
        const rb = corpusRank(b.corpus);
        if (ra !== rb) return ra - rb;
        const la = String(a.corpus||'') + ' ' + String(a.path?.chapter ?? a.path?.title ?? '');
        const lb = String(b.corpus||'') + ' ' + String(b.path?.chapter ?? b.path?.title ?? '');
        if (la !== lb) return la.localeCompare(lb);
        return String(a.heading||'').localeCompare(String(b.heading||''));
      });

      const label = (catId === 'OTHER') ? 'Other' : (state.categoriesById[catId]?.label || 'Other');

      const details = document.createElement('details');
      details.className = 'catgroup';

      const summary = document.createElement('summary');
      summary.className = 'catgroup-summary';
      summary.innerHTML = `<span class="catgroup-title">${escapeHtml(label)}</span><span class="catgroup-count">${recs.length}</span>`;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'catgroup-body';

      const showN = Math.min(perCatDefault, recs.length);
      total += showN;

      for (const rec of recs.slice(0, showN)) {
        const card = document.createElement('div');
        card.className = 'card';

        const top = document.createElement('div');
        top.className = 'card-top';

        const left = document.createElement('div');
        const badges = document.createElement('div');
        badges.className = 'badges';

        const catBadge = `<span class="badge badge-soft">${escapeHtml(label)}</span>`;

        const location = (() => {
          if (rec.corpus === 'DCS') return `DCS Ch ${escapeHtml(rec.path?.chapter ?? '')}`;
          if (rec.corpus === 'BRC') return `BRC Title ${escapeHtml(String(rec.path?.title ?? '').padStart(2,'0'))}`;
          if (rec.corpus === 'TITLE9') return `Title 9 Ch ${escapeHtml(rec.path?.chapter ?? '')}`;
          return escapeHtml(rec.corpus || '');
        })();

        badges.innerHTML = `${catBadge}
          <span class="badge"><strong>${escapeHtml(rec.corpus)}</strong></span>
          <span class="badge">${location}</span>
          <span class="badge">Anchor: <strong>${escapeHtml(rec.anchor)}</strong></span>`;
        left.appendChild(badges);

        const heading = document.createElement('div');
        heading.className = 'heading';
        heading.textContent = rec.heading || '(No heading)';
        left.appendChild(heading);

        const snip = document.createElement('p');
        snip.className = 'snip';
        const snippetText = buildSnippet(rec.text || rec.snippet || rec.verbatim || '', state.lastQuery, state.lastQueryConceptTerms);
        snip.innerHTML = highlightSnippetHtml(snippetText, state.lastQuery);
        left.appendChild(snip);

        top.appendChild(left);
        card.appendChild(top);

        const actions = document.createElement('div');
        actions.className = 'actions';
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Show code';
        btn.addEventListener('click', () => toggleVerbatim(card, rec, btn));
        actions.appendChild(btn);

        // Read-through mode (per chapter/title)
        const readLabel = (rec.corpus === 'BRC') ? 'Read title' : 'Read chapter';
        const readBtn = document.createElement('button');
        readBtn.className = 'btn';
        readBtn.type = 'button';
        readBtn.textContent = readLabel;
        readBtn.addEventListener('click', () => openReaderForRecord(rec));
        actions.appendChild(readBtn);

        card.appendChild(actions);

        body.appendChild(card);
      }

      details.appendChild(body);
      container.appendChild(details);
    }

    $("count").textContent = total.toLocaleString();
    if (!container.children.length) {
      container.innerHTML = '<div class="card"><div class="snip">No items for the selected filters.</div></div>';
    }
  }
  async function loadChunk(path) {
    if (state.chunkCache.has(path)) return state.chunkCache.get(path);
    const { data } = await fetchJsonWithFallbacks(path);
    if (!Array.isArray(data)) throw new Error("Chunk format unexpected (expected array)");
    state.chunkCache.set(path, data);
    return data;
  }

  async function toggleVerbatim(card, rec, btnEl) {
    // Inline expansion (no <dialog> dependency; iOS-friendly)
    let block = card.querySelector('.verbatim-block');
    if (block) {
      const isHidden = block.classList.toggle('hidden');
      if (btnEl) btnEl.textContent = isHidden ? 'Show code' : 'Hide code';
      return;
    }

    block = document.createElement('div');
    block.className = 'verbatim-block';

    // Source/context header (critical for field use)
    const meta = document.createElement('div');
    meta.className = 'verbatim-meta';
    const loc = (() => {
      if (rec.corpus === 'DCS') {
        const ch = rec.path?.chapter ?? '';
        return `DCS — Chapter ${ch}`;
      }
      if (rec.corpus === 'BRC') {
        const t = rec.path?.title ?? '';
        return `BRC — Title ${String(t).padStart(2,'0')}`;
      }
      if (rec.corpus === 'TITLE9') {
        const ch = rec.path?.chapter ?? '';
        return `Title 9 — Chapter ${ch}`;
      }
      return rec.corpus || '';
    })();
    const anchor = rec.anchor ? `Anchor: ${rec.anchor}` : '';
    meta.innerHTML = `<div><strong>${escapeHtml(loc)}</strong></div>` +
      (anchor ? `<div class="muted">${escapeHtml(anchor)}</div>` : '') +
      (rec.heading ? `<div class="muted">${escapeHtml(rec.heading)}</div>` : '');
    block.appendChild(meta);

    const pre = document.createElement('pre');
    pre.className = 'verbatim-text';
    pre.textContent = 'Loading code...';

    block.appendChild(pre);
    card.appendChild(block);
    if (btnEl) btnEl.textContent = 'Hide code';

    try {
      setStatus('Loading code...');
      const chunkPath = normalizeFilePath(rec.file);
      const chunk = await loadChunk(chunkPath);
      const full = chunk[rec.rec_index];
      if (!full) throw new Error('Record index not found in chunk');
      pre.textContent = full.verbatim || full.text || '(No verbatim text found in chunk)';
      setStatus('Ready');
    } catch (e) {
      console.error(e);
      pre.textContent = 'Error loading code: ' + (e.message || String(e));
      setStatus('Error: ' + (e.message || String(e)));
    }
  }


  async function openReaderForRecord(rec){
    try {
      state.reader.fromView = state.view || 'search';
      state.reader.fromScrollY = window.scrollY || 0;
      state.reader.file = normalizeFilePath(rec.file);
      state.reader.label = readerContextLabel(rec);
      state.reader.visible = state.reader.pageSize;
      state.reader.active = true;
      setView('reader');
      setStatus('Loading chapter…');
      state.reader.chunk = await loadChunk(state.reader.file);
      renderReader();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
      setStatus('Ready');
    } catch (e) {
      console.error(e);
      setStatus('Error: ' + (e.message || String(e)));
    }
  }

  function closeReader(){
    state.reader.active = false;
    state.reader.chunk = null;
    const backTo = state.reader.fromView || 'search';
    setView(backTo);
    if (backTo === 'browse') renderBrowse();
    else renderSearchResults();
    try { window.scrollTo(0, state.reader.fromScrollY || 0); } catch (_) {}
  }

  function renderReader(){
    const container = $('results');
    container.innerHTML = '';

    if (!state.reader.active || !Array.isArray(state.reader.chunk)) {
      container.innerHTML = '<div class="card"><div class="snip">Reader unavailable.</div></div>';
      return;
    }

    // Header
    const header = document.createElement('div');
    header.className = 'reader-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'reader-titlewrap';
    const title = document.createElement('div');
    title.className = 'reader-title';
    title.textContent = state.reader.label || 'Reader';
    const subtitle = document.createElement('div');
    subtitle.className = 'reader-sub';
    subtitle.textContent = 'Read-through mode (offline-safe)';
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const controls = document.createElement('div');
    controls.className = 'reader-controls';

    const jump = document.createElement('select');
    jump.className = 'select';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = 'Jump to section…';
    jump.appendChild(opt0);

    const visibleN = Math.min(state.reader.visible, state.reader.chunk.length);
    for (let i=0;i<visibleN;i++){
      const r = state.reader.chunk[i] || {};
      const heading = String(r.heading || '').trim();
      if (!heading) continue;
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = heading.length > 90 ? heading.slice(0, 90) + '…' : heading;
      jump.appendChild(o);
    }
    jump.addEventListener('change', () => {
      const i = parseInt(jump.value, 10);
      if (!Number.isFinite(i)) return;
      const el = document.getElementById('sec-' + i);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const back = document.createElement('button');
    back.className = 'btn';
    back.type = 'button';
    back.textContent = 'Back to results';
    back.addEventListener('click', closeReader);

    controls.appendChild(jump);
    controls.appendChild(back);

    header.appendChild(titleWrap);
    header.appendChild(controls);
    container.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'reader-body';

    const q = state.lastQuery || '';

    for (let i=0;i<visibleN;i++){
      const r = state.reader.chunk[i] || {};
      const sec = document.createElement('div');
      sec.className = 'reader-section';
      sec.id = 'sec-' + i;

      const h = document.createElement('div');
      h.className = 'reader-section-heading';
      h.textContent = r.heading || r.anchor || `Section ${i+1}`;
      sec.appendChild(h);

      const pre = document.createElement('pre');
      pre.className = 'reader-section-text';
      const verb = String(r.verbatim || r.text || '');
      if (q) pre.innerHTML = highlightSnippetHtml(verb, q);
      else pre.textContent = verb;
      sec.appendChild(pre);

      body.appendChild(sec);
    }

    container.appendChild(body);

    // Load more
    if (state.reader.chunk.length > visibleN){
      const actions = document.createElement('div');
      actions.className = 'actions';
      const more = document.createElement('button');
      more.className = 'btn';
      more.type = 'button';
      const addN = Math.min(state.reader.pageSize, state.reader.chunk.length - visibleN);
      more.textContent = `Load more (${addN})`;
      more.addEventListener('click', () => {
        state.reader.visible = Math.min(state.reader.chunk.length, state.reader.visible + state.reader.pageSize);
        renderReader();
      });
      actions.appendChild(more);
      container.appendChild(actions);
    }
  }

  function renderSearchResults(){
    const results = Array.isArray(state.search.results) ? state.search.results : [];
    const topList = Array.isArray(state.search.top) ? state.search.top : [];
    const total = results.length;
    const cap = state.search.renderCap || 500;
    const shown = Math.min(total, state.search.visible || state.search.pageSize || 50, cap);

    // Update meta count (showing X of Y)
    if (!total) {
      $('count').textContent = '0';
    } else if (shown < total) {
      $('count').textContent = `${shown} of ${total}`;
    } else {
      $('count').textContent = String(total);
    }

    const container = $('results');
    container.innerHTML = '';

    // --- Top matches (always across ALL categories, regardless of category filter) ---
    if ((state.lastQuery || '').trim() && topList.length) {
      // Collapsible to keep the landing view tight.
      const prefKey = 'cc_topmatches_open';
      const saved = localStorage.getItem(prefKey);
      const defaultOpen = (saved === null) ? true : (saved === '1');

      const wrap = document.createElement('details');
      wrap.className = 'topmatches';
      wrap.open = defaultOpen;

      const exact = topList.filter(r => (r._exact || 0) === 1);
      const near = topList.filter(r => (r._exact || 0) !== 1);
      const ordered = exact.concat(near).slice(0, 10);

      const summary = document.createElement('summary');
      summary.className = 'topmatches-summary';
      summary.innerHTML = `<div class="topmatches-title">Top matches</div><div class="topmatches-meta">${ordered.length} shown</div>`;
      wrap.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'topmatches-body';

      for (const rec of ordered) {
        const catId = (rec._primaryCategoryId && state.categoriesById[rec._primaryCategoryId])
          ? rec._primaryCategoryId
          : 'OTHER';
        const catLabel = (catId === 'OTHER') ? 'Other' : (state.categoriesById[catId]?.label || 'Other');
        body.appendChild(buildResultCard(rec, catLabel));
      }

      wrap.appendChild(body);
      wrap.addEventListener('toggle', () => {
        try { localStorage.setItem(prefKey, wrap.open ? '1' : '0'); } catch (e) {}
      });

      container.appendChild(wrap);
    }

    // --- Category windows (existing behavior, respects category filter) ---
    const slice = results.slice(0, shown);
    renderResultsInto(container, slice, { perCatDefault: 9999, skipCount: true, appendOnEmpty: true });

    // Load more controls
    if (total > shown) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const more = document.createElement('button');
      more.className = 'btn';
      more.type = 'button';
      const addN = Math.min(state.search.pageSize || 50, cap - shown, total - shown);
      more.textContent = `Load more (${addN})`;
      more.addEventListener('click', () => {
        state.search.visible = Math.min(cap, total, (state.search.visible || 0) + (state.search.pageSize || 50));
        renderSearchResults();
      });
      actions.appendChild(more);
      container.appendChild(actions);

      if (total > cap) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.style.marginTop = '6px';
        note.textContent = `Showing up to ${cap} results max. Refine your search to narrow further.`;
        container.appendChild(note);
      }
    }
  }

  // ----------------------------
  // Utility separation mode
  // ----------------------------
  const UTILITY_OPTIONS = [
    { id: 'GAS', label: 'Gas', terms: ['gas', 'natural gas'] },
    { id: 'WATER', label: 'Water', terms: ['water', 'potable', 'domestic water'] },
    { id: 'SANITARY', label: 'Sanitary sewer', terms: ['sanitary', 'sewer', 'sanitary sewer'] },
    { id: 'STORM', label: 'Storm sewer', terms: ['storm', 'drainage', 'storm sewer'] },
    { id: 'ELECTRIC', label: 'Electric', terms: ['electric', 'power', 'primary', 'secondary'] },
    // Telecom is the legacy terminology used across many standards; include fiber as a synonym.
    { id: 'TELECOM', label: 'Telecom / fiber', terms: ['telecom', 'telecommunication', 'communications', 'fiber', 'fibre', 'catv'] },
  ];

  function setUtilSepEnabled(on) {
    state.utilSep.enabled = Boolean(on);
    const controls = document.getElementById('utilSepControls');
    const results = document.getElementById('utilSepResults');
    if (controls) controls.hidden = !state.utilSep.enabled;
    if (results) results.hidden = !state.utilSep.enabled;
    if (!state.utilSep.enabled) {
      state.utilSep.results = [];
      state.utilSep.query = '';
      renderUtilSepResults();
    }
  }

  function populateUtilSelect(selectEl, value) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    for (const u of UTILITY_OPTIONS) {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.label;
      selectEl.appendChild(o);
    }
    selectEl.value = value;
  }

  function utilById(id) {
    return UTILITY_OPTIONS.find(u => u.id === id) || UTILITY_OPTIONS[0];
  }

  function buildUtilSepQuery(newId, existingId, orient) {
    const nu = utilById(newId);
    const ex = utilById(existingId);
    const o = (orient === 'V') ? 'vertical' : 'horizontal';
    // Build a deterministic query that favors separation language.
    // Include both canonical labels and synonyms so older docs still match.
    const nuTerms = Array.from(new Set([nu.label, ...nu.terms])).join(' ');
    const exTerms = Array.from(new Set([ex.label, ...ex.terms])).join(' ');
    const sepTerms = (orient === 'V')
      ? 'vertical separation clearance depth cover above below crossing'
      : 'horizontal separation clearance offset parallel crossing';
    return `${nuTerms} ${exTerms} ${o} ${sepTerms} minimum shall maintain`;
  }

  function recordTextForHit(rec) {
    return norm(`${rec.anchor || ''} ${rec.heading || ''} ${rec.text || rec.snippet || rec.verbatim || ''}`);
  }

  function countAny(hay, terms) {
    let c = 0;
    for (const t of terms) {
      const tn = norm(t);
      if (tn && hay.includes(tn)) c++;
    }
    return c;
  }

  function utilSepBoost(rec, newId, existingId, orient) {
    const hay = recordTextForHit(rec);
    const nu = utilById(newId);
    const ex = utilById(existingId);
    // Utility presence: reward records containing BOTH utilities.
    const nuHits = countAny(hay, nu.terms.concat([nu.label]));
    const exHits = countAny(hay, ex.terms.concat([ex.label]));

    let bonus = 0;

    // Strongly reward records that mention both utilities.
    if (nuHits > 0) bonus += 70;
    if (exHits > 0) bonus += 70;
    if (nuHits > 0 && exHits > 0) bonus += 240; // both present (dominant signal)

    // Separation language bonus (core terms outrank generic "minimum/shall" language).
    const sepCore = ['separation', 'clearance', 'offset', 'parallel', 'crossing', 'encase', 'encased', 'sleeve', 'trench', 'conduit', 'duct'];
    const sepWeak = ['minimum', 'shall', 'maintain', 'feet', 'foot', 'ft', 'inches', 'inch', 'in.'];
    const sepCoreHits = countAny(hay, sepCore);
    const sepWeakHits = countAny(hay, sepWeak);
    bonus += Math.min(220, sepCoreHits * 28) + Math.min(80, sepWeakHits * 6);

    // Orientation bonus (avoid letting "cover/depth" outrank true vertical separation).
    if (orient === 'V') {
      const vCore = ['vertical', 'above', 'below', 'over', 'under', 'crossing'];
      const vCover = ['cover', 'depth'];
      const vCoreHits = countAny(hay, vCore);
      const vCoverHits = countAny(hay, vCover);
      bonus += Math.min(160, vCoreHits * 18);
      // Only modestly reward cover/depth, and only if BOTH utilities are present.
      if (nuHits > 0 && exHits > 0) bonus += Math.min(40, vCoverHits * 10);
      else bonus += Math.min(12, vCoverHits * 4);
    } else {
      const hCore = ['horizontal', 'parallel', 'lateral', 'offset'];
      bonus += Math.min(160, countAny(hay, hCore) * 18);
    }

    // Penalize drainage-structure crossing guidance (ditches/culverts/etc.) so it doesn't outrank
    // true utility-to-utility separation requirements.
    const drainageCross = ['ditch', 'ditches', 'culvert', 'culverts', 'headwall', 'flume', 'channel', 'inlet', 'outfall', 'riprap', 'hydraulic', 'scour', 'waterway'];
    const drainHits = countAny(hay, drainageCross);
    if (drainHits) {
      // If the excerpt isn't explicitly separation/clearance language, push it way down.
      const hasExplicitSep = hay.includes('separation') || hay.includes('clearance') || hay.includes('offset');
      bonus -= hasExplicitSep ? 120 : 320;
    }

    return bonus;
  }

  function utilSepEligible(rec, newId, existingId, orient) {
    const hay = recordTextForHit(rec);
    const nu = utilById(newId);
    const ex = utilById(existingId);
    const nuHits = countAny(hay, nu.terms.concat([nu.label]));
    const exHits = countAny(hay, ex.terms.concat([ex.label]));
    if (!(nuHits > 0 && exHits > 0)) return false;

    // Require at least one separation signal so general construction guidance doesn't crowd results.
    const sepSignals = (orient === 'V')
      ? ['separation', 'clearance', 'vertical', 'above', 'below', 'over', 'under', 'crossing', 'offset', 'encase', 'encased', 'sleeve']
      : ['separation', 'clearance', 'horizontal', 'parallel', 'lateral', 'offset', 'crossing', 'encase', 'encased', 'sleeve'];
    return countAny(hay, sepSignals) > 0;
  }

  function runUtilitySeparation() {
    if (!state.utilSep.enabled) return;
    const newId = state.utilSep.newUtil;
    const exId = state.utilSep.existingUtil;
    const orient = state.utilSep.orient;
    const qRaw = buildUtilSepQuery(newId, exId, orient);
    const q = expandQuery(qRaw); // ensures fiber => telecom
    state.utilSep.query = q;

    // Intents/concepts help with snippet focus; keep them on the generated query.
    const intents = detectIntents(q);
    const qConcept = detectQueryConcepts(q);
    const conceptTerms = (qConcept.matches || []).map(m => m.termRaw);

    const scored = [];
    for (const rec of state.index) {
      // Respect corpus filter (same as main UI)
      if (state.filter && state.filter !== 'ALL' && rec.corpus !== state.filter) continue;
      // Utility Separation generates long weighted queries; relax minimum evidence to avoid suppressing valid matches.
      const r = scoreRecord(rec, q, intents, qConcept, { minHit: 'any' });
      if (!r) continue;

      // Mode-specific eligibility: ensure both utilities + at least one separation signal.
      if (!utilSepEligible(rec, newId, exId, orient)) continue;

      rec._tier = 0;
      rec._score = (r.score || 0) + utilSepBoost(rec, newId, exId, orient);
      rec._exact = r.phraseHit ? 1 : 0;
      scored.push(rec);
    }

    // Sort using the same contract as main search, but without category filtering.
    scored.sort((a,b)=>{
      const ea = (a._exact || 0);
      const eb = (b._exact || 0);
      if (ea !== eb) return eb - ea;
      const sa = (a._score || 0);
      const sb = (b._score || 0);
      if (sa !== sb) return sb - sa;
      return 0;
    });

    const exact = scored.filter(r => (r._exact || 0) === 1);
    const near = scored.filter(r => (r._exact || 0) !== 1);
    state.utilSep.results = exact.concat(near).slice(0, 3);
    state.utilSep._conceptTerms = conceptTerms;
    renderUtilSepResults();
  }

  function renderUtilSepResults() {
    const wrap = document.getElementById('utilSepResults');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.utilSep.enabled) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    const list = Array.isArray(state.utilSep.results) ? state.utilSep.results : [];
    const q = state.utilSep.query || '';
    const subtitle = document.createElement('div');
    subtitle.className = 'utilsep-subtitle';
    subtitle.textContent = list.length ? `Top ${list.length} match${list.length===1?'':'es'} (citations required)` : 'No separation matches found — adjust utilities or broaden corpus.';
    wrap.appendChild(subtitle);

    for (const rec of list) {
      const catId = (rec._primaryCategoryId && state.categoriesById[rec._primaryCategoryId])
        ? rec._primaryCategoryId
        : 'OTHER';
      const catLabel = (catId === 'OTHER') ? 'Other' : (state.categoriesById[catId]?.label || 'Other');
      wrap.appendChild(buildResultCard(rec, catLabel, q, state.utilSep._conceptTerms || []));
    }
  }

  async function runSearch() {
    const qRaw = getQuery();
    const q = expandQuery(qRaw);

    // Track key changes (query + filters) to reset pagination and expansions
    const key = `${qRaw}|${state.filter||'ALL'}|${state.categoryFilter||'ALL'}`;
    if (key !== state.search.key) {
      state.search.key = key;
      state.search.visible = state.search.pageSize || 50;
      state.expandedGroups.clear();
    }

    state.lastQueryRaw = qRaw;
    state.lastQuery = q;

    if ((!state.index || state.index.length === 0) && state.indexMode === "chunked") {
      // Stream chunks on-demand instead of requiring a monolithic index.
      if (!q) {
        $('count').textContent = '0';
        state.search.results = [];
        state.search.top = [];
        renderCategoryBoxes();
        setView('browse');
        renderBrowse();
        setStatus('Dataset ready. Type a search to load chunks.');
        return;
      }
      // Chunked search is mandatory in chunked mode. No monolithic fallback.
      await runSearchChunked(qRaw, q);
      return;
    }

    if (!state.index || state.index.length === 0) {
      setStatus('No dataset loaded yet. Run the compiler to generate ./data and redeploy.');
      $('count').textContent = '0';
      state.search.results = [];
      state.search.top = [];
      setView('search');
      $('results').innerHTML = `<div class="card"><div class="snip">No dataset loaded yet. Compile a dataset (Codes / Standards / Drawings) and redeploy this site.</div></div>`;
      return;
    }

    if (!q) {
      $('count').textContent = '0';
      state.search.results = [];
      state.search.top = [];
      // Reset quick category tiles to default ordering when not searching.
      renderCategoryBoxes();
      setView('browse');
      renderBrowse();
      return;
    }

    const sectionIntent = detectSectionQuery(q);
    const chapterIntent = null; // reserved for chapter-focused corpora

    const intents = detectIntents(q);
    const qConcept = detectQueryConcepts(q);
    state.lastQueryConceptTerms = (qConcept.matches || []).map(m => m.termRaw);
    state.lastActiveTopics = intents.topics;

    const scoredAllCats = [];
    const scoredFiltered = [];

    const canIncludeInFiltered = (rec) => {
      if (!state.categoryFilter || state.categoryFilter === 'ALL') return true;
      return String(rec._primaryCategoryId || '') === String(state.categoryFilter);
    };

    for (const rec of state.index) {
      // Respect corpus filter early (speed + predictable behavior)
      if (state.filter && state.filter !== 'ALL' && rec.corpus !== state.filter) continue;
      const includeFiltered = canIncludeInFiltered(rec);

      // If the user asked for a specific BRC-style section (e.g. "Section 8-5-12"),
      // hard-prefer the actual section record (anchor match) over secondary mentions.
      if (sectionIntent && sectionAnchorMatch(rec, sectionIntent)) {
        rec._tier = 0;
        rec._score = 200000; // Above chapter intent
        rec._rationale = 'Section intent';
        rec._tags = tagRecord(rec);
        rec._section = 1;
        scoredAllCats.push(rec);
        if (includeFiltered) scoredFiltered.push(rec);
        continue;
      }

      // If the user asked for a specific chapter (e.g. 'Chapter 5'), include that chapter
      // even if the text doesn't literally contain the number.
      if (chapterIntent && chapterMatch(rec, chapterIntent)) {
        rec._tier = 0;
        rec._score = 100000; // Force chapter-targeted items to the top
        rec._rationale = 'Chapter intent';
        rec._tags = tagRecord(rec);
        rec._section = 0;
        scoredAllCats.push(rec);
        if (includeFiltered) scoredFiltered.push(rec);
        continue;
      }



      const r = scoreRecord(rec, q, intents, qConcept);
      if (r) {
        rec._tier = 0;
        rec._score = r.score || 0;
        rec._exact = r.phraseHit ? 1 : 0;
        scoredAllCats.push(rec);
        if (includeFiltered) scoredFiltered.push(rec);
      }
    }

    const sortScored = (arr) => {
      arr.sort((a,b)=>{
        // Section intent is the strongest: always show the actual section first.
        if (sectionIntent) {
          const am = sectionAnchorMatch(a, sectionIntent);
          const bm = sectionAnchorMatch(b, sectionIntent);
          if (am !== bm) return bm - am;
        }

        if (chapterIntent) {
          const am = chapterMatch(a, chapterIntent);
          const bm = chapterMatch(b, chapterIntent);
          if (am !== bm) return bm - am;
        }

        // Exact phrase beats hierarchy/tier.
        const ea = (a._exact || 0);
        const eb = (b._exact || 0);
        if (ea !== eb) return eb - ea;

        const sa = (a._score || 0);
        const sb = (b._score || 0);

        // When both are exact phrase matches, rank by score first, then tier.
        if (ea === 1 && eb === 1) {
          if (sa !== sb) return sb - sa;
        } else {
          // Otherwise use tier contract first, then relevance.
          if (sa !== sb) return sb - sa;
        }
        const ca = String(a.corpus || '');
        const cb = String(b.corpus || '');
        if (ca !== cb) return ca.localeCompare(cb);
        const ha = String(a.heading || '');
        const hb = String(b.heading || '');
        if (ha !== hb) return ha.localeCompare(hb);
        return 0;
      });
    };

    sortScored(scoredAllCats);
    sortScored(scoredFiltered);

    // Top matches: exact phrase hits first, then near matches. Cap at 10.
    const exact = scoredAllCats.filter(r => (r._exact || 0) === 1);
    const near = scoredAllCats.filter(r => (r._exact || 0) !== 1);
    state.search.top = exact.concat(near).slice(0, 10);

    // Save + render
    state.search.results = scoredFiltered;
    // Re-order quick category tiles by relevance for the active query.
    renderCategoryBoxes(computeCategoryOrderFromResults(scoredFiltered));
    setView('search');
    renderSearchResults();
  }

  function populateCategorySelect() {
    const sel = document.getElementById('catSelect');
    if (!sel) return;
    sel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'ALL';
    optAll.textContent = 'All categories';
    sel.appendChild(optAll);
    for (const c of state.categories) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.label}`;
      sel.appendChild(o);
    }
    sel.value = state.categoryFilter || 'ALL';
  }

  function renderCategoryBoxes(orderIds) {
    const wrap = document.getElementById('catBoxes');
    if (!wrap) return;
    wrap.innerHTML = '';

    const makeBtn = (id, label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'catbox';
      b.dataset.cat = id;
      b.textContent = label;
      b.addEventListener('click', () => {
        state.categoryFilter = id;
        const sel = document.getElementById('catSelect');
        if (sel) sel.value = id;
        updateCategoryBoxActive();
        runSearch();
        document.getElementById('q')?.focus?.();
      });
      wrap.appendChild(b);
    };

    makeBtn('ALL', 'All');

    const byId = state.categoriesById || {};
    const ids = Array.isArray(orderIds) && orderIds.length
      ? orderIds.filter(id => id !== 'ALL' && byId[id])
      : state.categories.map(c => c.id);

    for (const id of ids) {
      const c = byId[id];
      if (!c) continue;
      makeBtn(c.id, c.label);
    }
    updateCategoryBoxActive();
  }

  
  function navigateToViewer(filePath, titleText) {
    const url = `./viewer.html?file=${encodeURIComponent(filePath)}&title=${encodeURIComponent(titleText||'')}`;
    // Force same-window navigation for PWA/webview consistency.
    window.location.assign(url);
  }

function renderTechnicalDrawings() {
    const wrap = document.getElementById('drawingsList');
    if (!wrap) return;
    wrap.innerHTML = '';
    const items = Array.isArray(state.drawings.items) ? state.drawings.items : [];
    if (!items.length) {
      wrap.innerHTML = `<div class="card"><div class="snip">No drawings loaded.</div></div>`;
      return;
    }
    for (const d of items) {
      if (!d || !d.file) continue;
      const a = document.createElement('a');
      a.className = 'drawings-link';
      const href = `./viewer.html?file=${encodeURIComponent('assets/technical-drawings/' + String(d.file))}&title=${encodeURIComponent(String(d.title||d.file))}`;
      a.href = href;
      a.target = '_self';
      a.rel = 'noopener';
      a.addEventListener('click', (e)=>{ e.preventDefault(); navigateToViewer('assets/technical-drawings/' + String(d.file), String(d.title||d.file)); });
      const left = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'drawings-link-title';
      title.textContent = String(d.title || d.file).replace(/\.pdf$/i, '');
      left.appendChild(title);
      const right = document.createElement('div');
      right.className = 'drawings-link-meta';
      right.textContent = 'PDF';
      a.appendChild(left);
      a.appendChild(right);
      wrap.appendChild(a);
    }
  }

  const SEPARATIONS_PINS = {
    // Higher-res raster for better zooming on mobile.
    tableImg: './assets/separations/utility-separations-table@4x.png',
    // Dedicated viewer page (works offline) for pinch-zoom / full-size readability.
    tableView: './viewer.html?file=assets/separations/utility-separations-table@4x.png&title=Utility%20Separation%20Table',

    // Pinned Chapter 4 DCS sections ONLY (per inspector workflow).
    pins: [
      { id: 'sepParallel',  corpus: 'DCS', anchor: '4.06(A)', label: 'Parallel (Horizontal) Separation' },
      { id: 'sepCrossings', corpus: 'DCS', anchor: '4.06(B)', label: 'Pipe Crossings (Vertical) Separation' },
      { id: 'sepDitch',     corpus: 'DCS', anchor: '4.06(C)', label: 'Drainageway and Irrigation Ditch Crossings' },
    ],
  };

  function getRecordByAnchor(corpus, anchor) {
    const c = String(corpus || '').toUpperCase();
    const a = String(anchor || '').trim();
    if (!a) return null;
    for (const r of state.index) {
      if (!r) continue;
      if (String(r.corpus || '').toUpperCase() !== c) continue;
      if (String(r.anchor || '').trim() === a) return r;
    }
    return null;
  }

  function renderSeparations() {
    const img = document.getElementById('separationsTableImg');
    const link = document.getElementById('separationsTableLink');
    if (img) img.src = SEPARATIONS_PINS.tableImg;
    if (link) link.href = SEPARATIONS_PINS.tableView;

    // Render the three pinned Chapter 4 sections beneath the table.
    for (const pin of (SEPARATIONS_PINS.pins || [])) {
      const wrap = document.getElementById(pin.id);
      if (!wrap) continue;
      wrap.innerHTML = '';
      const rec = getRecordByAnchor(pin.corpus, pin.anchor);
      if (!rec) {
        wrap.innerHTML = `<div class="card"><div class="snip">Pinned section ${escapeHtml(pin.anchor)} not found in index.</div></div>`;
        continue;
      }
      wrap.appendChild(buildResultCard(rec, 'Separations', '', []));
    }
  }

  const RESTORATION_PINS = {
    pins: [
      { id: 'restorationPinned', corpus: 'BRC', anchor: '8-5-12', label: 'BRC 8-5-12' },
    ],
  };

  function renderRestorationStandards() {
    for (const pin of (RESTORATION_PINS.pins || [])) {
      const wrap = document.getElementById(pin.id);
      if (!wrap) continue;
      wrap.innerHTML = '';
      const rec = getRecordByAnchor(pin.corpus, pin.anchor);
      if (!rec) {
        wrap.innerHTML = `<div class="card"><div class="snip">Pinned section ${escapeHtml(pin.anchor)} not found in index.</div></div>`;
        continue;
      }
      wrap.appendChild(buildResultCard(rec, 'Restoration', '', []));
    }
  }


  function computeCategoryOrderFromResults(results, opts = {}) {
    const rows = Array.isArray(results) ? results : [];
    const stats = new Map(); // id -> {count, best}
    for (const r of rows) {
      const id = String(r._primaryCategoryId || '');
      if (!id) continue;
      const base = (r._score || 0);
      const bonus = (r._exact ? 50000 : 0) + (r._section ? 100000 : 0) + (r._rationale === 'Chapter intent' ? 20000 : 0);
      const s = base + bonus;
      const cur = stats.get(id) || { count: 0, best: -Infinity };
      cur.count += 1;
      if (s > cur.best) cur.best = s;
      stats.set(id, cur);
    }
    let ids = state.categories.map(c => c.id);
    if (opts.hideEmpty) {
      ids = ids.filter(id => (stats.get(id)?.count || 0) > 0);
    }
    ids.sort((a,b) => {
      const sa = stats.get(a) || {count:0,best:-Infinity};
      const sb = stats.get(b) || {count:0,best:-Infinity};
      if (sa.best !== sb.best) return sb.best - sa.best;
      if (sa.count !== sb.count) return sb.count - sa.count;
      // Stable tie-breaker: default workflow order from categories.json
      const ia = state.categories.findIndex(c => c.id === a);
      const ib = state.categories.findIndex(c => c.id === b);
      if (ia !== ib) return ia - ib;
      const la = (state.categoriesById[a]?.label || a);
      const lb = (state.categoriesById[b]?.label || b);
      return String(la).localeCompare(String(lb));
    });
    return ids;
  }

  function updateCategoryBoxActive() {
    const active = state.categoryFilter || 'ALL';
    document.querySelectorAll('.catbox').forEach(b => {
      b.classList.toggle('active', (b.dataset.cat || 'ALL') === active);
    });
  }

  function fullReset() {
    // Inputs
    const qEl = document.getElementById('q');
    if (qEl) qEl.value = '';

    // State
    state.filter = 'ALL';
    state.categoryFilter = 'ALL';
    state.expandedGroups.clear();
    state.lastQuery = '';
    state.lastActiveTopics = [];
    state.lastQueryConceptTerms = [];

    // UI selects
    const corpusSel = document.getElementById('corpusSelect');
    if (corpusSel) corpusSel.value = 'ALL';
    const catSel = document.getElementById('catSelect');
    if (catSel) catSel.value = 'ALL';

    updateCategoryBoxActive();
    runSearch();
    qEl?.focus?.();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
  }

  function wireUI() {
    const corpusSel = document.getElementById('corpusSelect');
    if (corpusSel) {
      corpusSel.value = state.filter || 'ALL';
      corpusSel.addEventListener('change', () => {
        state.filter = corpusSel.value || 'ALL';
        runSearch();
        if (state.utilSep.enabled) runUtilitySeparation();
      });
    }

    const catSel = document.getElementById('catSelect');
    if (catSel) {
      catSel.addEventListener('change', () => {
        state.categoryFilter = catSel.value || 'ALL';
        updateCategoryBoxActive();
        runSearch();
      });
    }

    let qTimer = null;
    const qEl = document.getElementById('q');
    qEl.addEventListener('input', () => {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        qTimer = null;
        runSearch();
      }, 140);
    });
    // "Clear" is a full reset per field-use expectations.
    document.getElementById('clear').addEventListener('click', () => fullReset());

    // Utility separation mode controls
    const toggle = document.getElementById('utilSepToggle');
    const selNew = document.getElementById('utilNew');
    const selEx = document.getElementById('utilExisting');
    const selOr = document.getElementById('utilOrientation');
    const runBtn = document.getElementById('utilSepRun');

    populateUtilSelect(selNew, state.utilSep.newUtil);
    populateUtilSelect(selEx, state.utilSep.existingUtil);
    if (selOr) selOr.value = state.utilSep.orient || 'H';

    if (toggle) {
      toggle.checked = Boolean(state.utilSep.enabled);
      toggle.addEventListener('change', () => {
        setUtilSepEnabled(toggle.checked);
        if (toggle.checked) runUtilitySeparation();
      });
    }

    const onAnyChange = () => {
      state.utilSep.newUtil = selNew?.value || state.utilSep.newUtil;
      state.utilSep.existingUtil = selEx?.value || state.utilSep.existingUtil;
      state.utilSep.orient = selOr?.value || state.utilSep.orient;
      if (state.utilSep.enabled) runUtilitySeparation();
    };
    selNew?.addEventListener('change', onAnyChange);
    selEx?.addEventListener('change', onAnyChange);
    selOr?.addEventListener('change', onAnyChange);
    runBtn?.addEventListener('click', () => {
      onAnyChange();
      runUtilitySeparation();
    });

    // Ensure initial hidden state is correct
    setUtilSepEnabled(Boolean(state.utilSep.enabled));
  }

  async function init() {
    try {
      // Footer stamp
      const y = document.getElementById('year');
      if (y) y.textContent = String(new Date().getFullYear());
      await loadDatasetManifest();
      applyDatasetBranding();
      populateCorpusSelect();
      wireUI();
      await loadCategories();
      populateCategorySelect();
      renderCategoryBoxes();
      await loadConcepts();
      applyDatasetFeatureToggles();
      if (state.dataset && state.dataset.features && state.dataset.features.drawingsLibrary) {
        await loadTechnicalDrawings();
        renderTechnicalDrawings();
      }
      await loadIndex();
      annotateIndex();
      runSearch();
      if ("serviceWorker" in navigator) {
    const h = String(location.hostname || "").toLowerCase();
    const isLocal = (h === "localhost" || h === "127.0.0.1");
    if (isLocal) {
      // Disable service worker on localhost to prevent stale-cached assets during development/testing.
      navigator.serviceWorker.getRegistrations().then((regs)=>{ regs.forEach(r=>r.unregister()); }).catch(()=>{});
    } else {
      navigator.serviceWorker.register("./service-worker.js").then((reg) => {
        console.log("SW registered", reg.scope);
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        console.log("SW controller changed");
      });
    }
  }
    } catch (e) {
      console.error(e);
      setStatus(`Error: ${e.message}`);
      $("results").innerHTML = `<div class="card"><div class="snip">${escapeHtml(e.message)}</div></div>`;
    }
  }

  window.addEventListener("DOMContentLoaded", init);
})();

// GLOBAL_PDF_VIEWER_ROUTER
document.addEventListener('click', function(e){
  const a = e.target.closest ? e.target.closest('a') : null;
  if(!a) return;
  const href = a.getAttribute('href') || '';
  if(!href) return;
  if(href.toLowerCase().endsWith('.pdf')){
    e.preventDefault();
    window.location.href = 'viewer.html?file=' + encodeURIComponent(href);
  }
});


// DRAWINGS_LINK_ROUTER
document.addEventListener('click', function(e){
  const a = e.target.closest ? e.target.closest('a.drawings-link') : null;
  if(!a) return;
  const href = a.getAttribute('href') || '';
  if(href.includes('viewer.html?file=')) {
    e.preventDefault();
    window.location.assign(href);
  }
}, true);