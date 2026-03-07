// ─── Constants ────────────────────────────────────────────────────────────────
const TOTAL_PAGES = 604;
const SURAH_NO_BASMALA = 9; // Surah At-Tawbah has no Basmala
const WARSH_MODAL_KEY = 'warshModalSeen';
const WARSH_TIMER_MS = 5000;

/**
 * Riwaya configuration.
 *
 * textPagesDir  : directory that holds 001.json … 604.json page chunks
 *                 + index.json (built by split_quran_text.py)
 * audioLazyDir  : directory that holds per-reciter/per-surah audio chunks
 *                 (built by split_reciters.py)
 * audioDir      : subfolder inside assets/audio_local/ for offline files
 * font          : CSS font-family name to apply when this riwaya is active
 * reciters      : map of reciter value → Arabic display name
 */
const RIWAYA_CONFIG = {
  warsh: {
    textPagesDir: 'assets/text/pages/warsh',
    audioLazyDir: 'assets/audio_cloud/warsh/lazy',
    audioDir: 'warsh',
    font: 'UthmanicWarsh',
    reciters: {
      'mahmoud_khalil_al-hussary': 'محمود خليل الحصري',
      abdelbasset_abdessamad: 'عبد الباسط عبد الصمد',
      yassen_al_jazairi: 'ياسين الجزائري',
    },
  },
  hafs: {
    textPagesDir: 'assets/text/pages/hafs',
    audioLazyDir: 'assets/audio_cloud/hafs/lazy',
    audioDir: 'hafs',
    font: 'UthmanicHafs',
    reciters: {
      'muhammad_siddiq_al-minshawi': 'محمد صديق المنشاوي',
      abdelbasset_abdessamad: 'عبد الباسط عبد الصمد',
    },
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  // ── Lazy-load caches ──────────────────────────────────────────────────────
  /** quranIndex: loaded once — contains sura_to_page, juz_to_page, sura_info, etc. */
  quranIndex: null,
  /** pageCache: Map<pageNum, ayah[]> — loaded on demand, kept in memory */
  pageCache: new Map(),
  /** audioSurahCache: Map<"reciter/surah", {base, ayahs}> — loaded on demand */
  audioSurahCache: new Map(),

  // ── Legacy / compatibility fields (kept for all existing function signatures) ──
  /**
   * quranData is now a *view* of the currently loaded pages rather than the
   * entire Quran. It is rebuilt whenever a page is loaded.
   * Functions that do a full scan (populateSurahSelector, navigation that
   * searches quranData) now use the index + per-page cache instead.
   */
  quranData: [],
  localAudioCache: {},
  useLocalAudio: true,
  currentPage: 1,
  currentSura: 1,
  currentJuz: 1,
  currentAyah: null,
  currentRiwaya: 'warsh',
  selectedReciter: '',
  audioPlayer: null,
  playQueue: [],
  currentPlayIndex: 0,
  repeatCount: 1,
  currentRepeatCount: 0,
  currentPlayModeRepeatCount: 0,
  isPlaying: false,
  isSwitchingRiwaya: false,
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function getEl(id) {
  return document.getElementById(id);
}
function saveSetting(key, value) {
  localStorage.setItem(key, value);
}
function applyFontSize(size) {
  getEl('quran-text').style.fontSize = size + 'px';
}

/**
 * Filter currently-cached quranData for ayahs that appear on a given page.
 * For the active page this is always populated; adjacent pages may not be.
 */
function getAyahsOnPage(pageNum) {
  const cached = state.pageCache.get(pageNum);
  return (
    cached ||
    state.quranData.filter((item) => {
      const pages = item.page.split('-');
      return pages.some((p) => parseInt(p.trim()) === pageNum);
    })
  );
}

function setActiveAyahElement(element) {
  document
    .querySelectorAll('.ayah.active')
    .forEach((el) => el.classList.remove('active'));
  if (element) {
    element.classList.add('active');
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function activateAyahInDOM(suraNo, ayahNo) {
  const el = document.querySelector(
    `[data-sura="${suraNo}"][data-ayah="${ayahNo}"]`,
  );
  setActiveAyahElement(el);
  return el;
}

function buildAudioPath(reciter, suraNo, ayahNo) {
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  const audioDir = cfg ? cfg.audioDir : state.currentRiwaya;
  return `assets/audio_local/${audioDir}/${reciter}/${String(suraNo).padStart(3, '0')}/${String(ayahNo).padStart(3, '0')}.mp3`;
}

/**
 * Look up a fallback online URL from the lazily-loaded audio surah cache.
 * Fetches the surah chunk for the required reciter+surah on first access.
 */
async function getFallbackAudioUrl(reciter, suraNo, ayahNo) {
  const suraKey = String(suraNo).padStart(3, '0');
  const ayahKey = String(ayahNo).padStart(3, '0');
  const cacheKey = `${reciter}/${suraKey}`;

  if (!state.audioSurahCache.has(cacheKey)) {
    await loadAudioSurahChunk(reciter, suraNo);
  }

  const chunk = state.audioSurahCache.get(cacheKey);
  if (!chunk) return null;

  const entries = chunk.ayahs?.[ayahKey];
  if (!entries?.length) return null;

  // Unified [account, token] structure for all CDNs.
  // Pick a random entry for load balancing across redundant accounts.
  const [acc, tok] = entries[Math.floor(Math.random() * entries.length)];

  // Cloudinary  (pre_v present):
  //   base + acc + "/" + pre_v + "/" + tok + "/" + path + ayahKey + ".mp3"
  if (chunk.pre_v) {
    return `${chunk.base}${acc}/${chunk.pre_v}/${tok}/${chunk.path}${ayahKey}.mp3`;
  }

  // ImageKit / generic  (no pre_v):
  //   base + acc + "/" + path + tok         (tok = "001.mp3")
  return `${chunk.base}${acc}/${chunk.path}${tok}`;
}

/**
 * Fetch a single per-surah audio chunk for one reciter and cache it.
 * Multiple callers may race here — the Promise is stored so they all await
 * the same fetch.
 */
const _audioChunkFetchPromises = new Map();

async function loadAudioSurahChunk(reciter, suraNo) {
  const suraKey = String(suraNo).padStart(3, '0');
  const cacheKey = `${reciter}/${suraKey}`;

  if (state.audioSurahCache.has(cacheKey)) return; // already loaded

  if (_audioChunkFetchPromises.has(cacheKey)) {
    return _audioChunkFetchPromises.get(cacheKey); // already in flight
  }

  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  if (!cfg) return;

  const url = `${cfg.audioLazyDir}/${reciter}/${suraKey}.json`;
  const promise = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      state.audioSurahCache.set(cacheKey, data);
    })
    .catch((err) => {
      console.warn(`Audio chunk not found: ${url}`, err);
      state.audioSurahCache.set(cacheKey, null); // mark as attempted
    })
    .finally(() => {
      _audioChunkFetchPromises.delete(cacheKey);
    });

  _audioChunkFetchPromises.set(cacheKey, promise);
  return promise;
}

/**
 * Prefetch audio chunks for adjacent surahs in the background so they're
 * ready before the user navigates there. Called after a surah is selected.
 */
function prefetchAdjacentAudioChunks(reciter, suraNo) {
  if (!reciter) return;
  [suraNo - 1, suraNo + 1].forEach((s) => {
    if (s >= 1 && s <= 114) {
      loadAudioSurahChunk(reciter, s).catch(() => {});
    }
  });
}

async function checkLocalAudioAvailable(reciter, suraNo) {
  const cacheKey = `${reciter}/${suraNo}`;
  if (cacheKey in state.localAudioCache) return state.localAudioCache[cacheKey];

  const testPath = buildAudioPath(reciter, suraNo, 1);
  try {
    const res = await fetch(testPath, { method: 'HEAD' });
    const contentType = res.headers.get('Content-Type') || '';
    const isAudio = res.ok && contentType.includes('audio');
    state.localAudioCache[cacheKey] = isAudio;
  } catch {
    state.localAudioCache[cacheKey] = false;
  }
  return state.localAudioCache[cacheKey];
}

function showToast(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText =
      'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText =
    'background:#5d4037;color:#fff;padding:12px 24px;border-radius:8px;font-family:Amiri,Arial,sans-serif;font-size:16px;box-shadow:0 4px 12px rgba(0,0,0,0.25);opacity:0;transition:opacity 0.3s;';
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
    });
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const savedRiwaya = localStorage.getItem('riwaya') || 'warsh';
  state.currentRiwaya = savedRiwaya;
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) riwayaSelect.value = savedRiwaya;

  // Load lightweight index first (tiny file — sura/juz → page map)
  await loadQuranIndex();

  // Populate static selectors from index (no full data needed)
  initializeSelectors();
  initializeAudioPlayer();
  loadSettings();
  applyRiwayaFont();
  populateReciterOptions();

  const startPage = parseInt(localStorage.getItem('currentPage')) || 1;
  const savedSura = parseInt(localStorage.getItem('currentSura')) || 1;
  const savedAyah = parseInt(localStorage.getItem('currentAyah')) || null;

  // Load + render only the starting page
  await displayPage(startPage, true);

  initializeEventListeners();
  initializeBottomControls();

  if (savedSura && savedAyah) {
    setTimeout(() => restoreSavedAyah(savedSura, savedAyah), 200);
  } else {
    setTimeout(async () => {
      const firstAyah = await getAyahBySuraAndAya(savedSura, 1);
      if (firstAyah) {
        state.currentAyah = firstAyah;
        state.currentSura = firstAyah.sura_no;
        populateAyahSelectorFromIndex(firstAyah.sura_no);
        getEl('ayah-select').value = 1;
        updatePageInfo(firstAyah);
        activateAyahInDOM(firstAyah.sura_no, 1);
        updateNavButtonStates();
      }
    }, 200);
  }
});

// ─── Data Loading — Lazy ──────────────────────────────────────────────────────

/**
 * Load the lightweight index once. Contains:
 *   sura_to_page, juz_to_page, page_to_suras, page_to_juz, sura_info
 */
async function loadQuranIndex() {
  try {
    const cfg = RIWAYA_CONFIG[state.currentRiwaya];
    const url = `${cfg.textPagesDir}/index.json`;
    const res = await fetch(url);
    state.quranIndex = await res.json();
  } catch (err) {
    console.error('Error loading Quran index:', err);
    showToast('خطأ في تحميل فهرس القرآن الكريم');
  }
}

/**
 * Fetch a single page chunk and cache it. Returns the ayah array.
 * Deduplicates concurrent fetches for the same page.
 */
const _pageChunkFetchPromises = new Map();

async function loadPageChunk(pageNum) {
  if (state.pageCache.has(pageNum)) return state.pageCache.get(pageNum);
  if (_pageChunkFetchPromises.has(pageNum))
    return _pageChunkFetchPromises.get(pageNum);

  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  const url = `${cfg.textPagesDir}/${String(pageNum).padStart(3, '0')}.json`;

  const promise = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((ayahs) => {
      // Re-inject fields stripped by split_quran_text.py to save file size:
      // page = filename IS the page; id = sura_no*1000+aya_no (unique for all 6236 ayahs)
      const pageStr = String(pageNum);
      ayahs.forEach((a) => {
        a.page = pageStr;
        a.id = a.sura_no * 1000 + a.aya_no;
      });
      state.pageCache.set(pageNum, ayahs);
      return ayahs;
    })
    .catch((err) => {
      console.error(`Failed to load page ${pageNum}:`, err);
      return [];
    })
    .finally(() => {
      _pageChunkFetchPromises.delete(pageNum);
    });

  _pageChunkFetchPromises.set(pageNum, promise);
  return promise;
}

/**
 * Prefetch adjacent pages in the background so navigation feels instant.
 */
function prefetchAdjacentPages(pageNum) {
  [pageNum - 1, pageNum + 1].forEach((p) => {
    if (p >= 1 && p <= TOTAL_PAGES && !state.pageCache.has(p)) {
      loadPageChunk(p).catch(() => {});
    }
  });
}

/**
 * Fetch a specific ayah by sura+aya. Loads the page chunk if needed.
 * Uses the index to know which page to fetch.
 */
async function getAyahBySuraAndAya(suraNo, ayaNo) {
  // First check already-loaded pages in quranData
  const fromLoaded = state.quranData.find(
    (i) => i.sura_no === suraNo && i.aya_no === ayaNo,
  );
  if (fromLoaded) return fromLoaded;

  // Use index to find the right page
  const pageNum = state.quranIndex?.sura_to_page?.[String(suraNo)];
  if (!pageNum) return null;

  const ayahs = await loadPageChunk(pageNum);
  return ayahs.find((i) => i.sura_no === suraNo && i.aya_no === ayaNo) || null;
}

/**
 * Drop ALL cached page/audio data (called on riwaya switch).
 */
function clearDataCaches() {
  state.quranIndex = null;
  state.pageCache.clear();
  state.audioSurahCache.clear();
  state.quranData = [];
  state.localAudioCache = {};
  _pageChunkFetchPromises.clear();
  _audioChunkFetchPromises.clear();
}

// ─── Legacy compatibility: loadQuranData & loadAudioUrlsData ─────────────────
// These are no-ops now — data is loaded lazily.  Kept so that any future
// callers of switchRiwaya() don't break.

async function loadQuranData() {
  /* no-op — lazy loading via loadPageChunk */
}
async function loadAudioUrlsData() {
  /* no-op — lazy loading via loadAudioSurahChunk */
}

// ─── Riwaya ──────────────────────────────────────────────────────────────────

function cycleRiwaya() {
  const riwayas = Object.keys(RIWAYA_CONFIG);
  const nextRiwaya =
    riwayas[(riwayas.indexOf(state.currentRiwaya) + 1) % riwayas.length];
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) riwayaSelect.value = nextRiwaya;
  switchRiwaya(nextRiwaya);
}

function applyRiwayaFont() {
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  if (!cfg) return;
  const quranTextEl = getEl('quran-text');
  if (quranTextEl) quranTextEl.style.fontFamily = `'${cfg.font}', serif`;

  const badge = getEl('riwaya-badge');
  if (badge) badge.textContent = state.currentRiwaya === 'hafs' ? 'حفص' : 'ورش';
}

function populateReciterOptions() {
  const reciterSelect = getEl('reciter-select');
  if (!reciterSelect) return;

  reciterSelect.innerHTML = '<option value="">اختر القارئ</option>';
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  if (!cfg) return;

  Object.entries(cfg.reciters).forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    reciterSelect.appendChild(opt);
  });

  const saved = localStorage.getItem('reciter') || '';
  reciterSelect.value = cfg.reciters[saved]
    ? saved
    : Object.keys(cfg.reciters)[0];
  state.selectedReciter = reciterSelect.value;
}

async function switchRiwaya(newRiwaya) {
  if (newRiwaya === state.currentRiwaya) return;

  const preservedSura = state.currentSura || 1;
  stopAudio();

  state.currentRiwaya = newRiwaya;
  saveSetting('riwaya', newRiwaya);

  clearDataCaches();
  showToast('تحويل الرواية...');

  await loadQuranIndex();
  applyRiwayaFont();
  populateReciterOptions();

  state.isSwitchingRiwaya = true;
  populateSurahSelector();
  populateJuzSelector();
  populatePageSelector();
  state.isSwitchingRiwaya = false;

  state.currentPage = 1;
  state.currentSura = preservedSura;
  state.currentJuz = 1;
  state.currentAyah = null;

  const targetPage =
    parseInt(state.quranIndex?.sura_to_page?.[String(preservedSura)]) || 1;

  await displayPage(targetPage, true);
  getEl('surah-select').value = preservedSura;
  saveSetting('currentSura', preservedSura);

  setTimeout(async () => {
    const firstAyah = await getAyahBySuraAndAya(preservedSura, 1);
    if (firstAyah) {
      state.currentAyah = firstAyah;
      populateAyahSelectorFromIndex(preservedSura);
      getEl('ayah-select').value = 1;
      updatePageInfo(firstAyah);
      activateAyahInDOM(preservedSura, 1);
      updateNavButtonStates();
    }
  }, 200);

  if (newRiwaya === 'warsh') showWarshModal();
}

// ─── Selectors ────────────────────────────────────────────────────────────────

function initializeSelectors() {
  populateSurahSelector();
  populateJuzSelector();
  populatePageSelector();
}

/** Build surah selector from the index (no page chunks needed). */
function populateSurahSelector() {
  const surahSelect = getEl('surah-select');
  surahSelect.innerHTML = '';

  const suraInfo = state.quranIndex?.sura_info || {};
  Object.entries(suraInfo).forEach(([suraNo, info]) => {
    const option = document.createElement('option');
    option.value = suraNo;
    option.textContent = `${suraNo}. ${info.name_ar}`;
    surahSelect.appendChild(option);
  });

  const savedSurah = localStorage.getItem('currentSura') || '1';
  surahSelect.value = savedSurah;
  state.currentSura = parseInt(savedSurah);
}

function populateJuzSelector() {
  const juzSelect = getEl('juz-select');
  juzSelect.innerHTML = '';

  for (let i = 1; i <= 30; i++) {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `الجزء ${i}`;
    juzSelect.appendChild(option);
  }

  const savedJuz = localStorage.getItem('currentJuz') || '1';
  juzSelect.value = savedJuz;
}

function populatePageSelector() {
  const pageSelect = getEl('page-select');
  pageSelect.innerHTML = '';

  for (let i = 1; i <= TOTAL_PAGES; i++) {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = `صفحة ${i}`;
    pageSelect.appendChild(option);
  }

  const savedPage = localStorage.getItem('currentPage') || '1';
  pageSelect.value = savedPage;
}

/**
 * Populate the ayah dropdown using the index (no chunk fetch needed).
 * Falls back to scanning quranData if the index has no count for this sura.
 */
function populateAyahSelectorFromIndex(suraNo) {
  const ayahSelect = getEl('ayah-select');
  ayahSelect.innerHTML = '<option value="">اختر الآية</option>';

  const suraInfo = state.quranIndex?.sura_info?.[String(suraNo)];
  const count = suraInfo?.ayah_count || 0;

  if (count > 0) {
    for (let i = 1; i <= count; i++) {
      const option = document.createElement('option');
      option.value = i;
      option.textContent = `آية ${i}`;
      ayahSelect.appendChild(option);
    }
  } else {
    // fallback: scan currently loaded data
    state.quranData
      .filter((item) => item.sura_no == suraNo)
      .forEach((ayah) => {
        const option = document.createElement('option');
        option.value = ayah.aya_no;
        option.textContent = `آية ${ayah.aya_no}`;
        ayahSelect.appendChild(option);
      });
  }
}

// Keep the old name working (used in many places)
function populateAyahSelector(suraNo) {
  populateAyahSelectorFromIndex(suraNo);
}

function updateSidebarSelectors() {
  if (state.currentAyah) {
    getEl('surah-select').value = state.currentAyah.sura_no;
    getEl('ayah-select').value = state.currentAyah.aya_no;
  }
}

// ─── Page Display ─────────────────────────────────────────────────────────────

/**
 * displayPage is now async — it fetches the page chunk if needed, then renders.
 */
async function displayPage(pageNum, keepCurrentSura = false) {
  state.currentPage = pageNum;
  saveSetting('currentPage', pageNum);

  // Fetch this page (from cache or network)
  const pageData = await loadPageChunk(pageNum);

  // Update quranData to contain at least the visible page so all legacy
  // functions that scan state.quranData still work for the current page.
  // We merge without duplicates.
  const existing = new Set(state.quranData.map((a) => a.id));
  pageData.forEach((a) => {
    if (!existing.has(a.id)) state.quranData.push(a);
  });

  if (pageData.length === 0) return;

  // Kick off background prefetch for neighbours
  prefetchAdjacentPages(pageNum);

  const quranTextDiv = getEl('quran-text');
  quranTextDiv.innerHTML = '';

  const displayedSuraHeaders = new Set();
  let previousSuraNo = null;

  const surahsStartingOnPage = new Set(
    pageData.filter((a) => a.aya_no === 1).map((a) => a.sura_no),
  );

  pageData.forEach((ayah) => {
    if (ayah.sura_no !== previousSuraNo) {
      previousSuraNo = ayah.sura_no;

      if (!displayedSuraHeaders.has(ayah.sura_no)) {
        displayedSuraHeaders.add(ayah.sura_no);

        const suraHeaderDiv = document.createElement('div');
        suraHeaderDiv.className = 'sura-header';
        suraHeaderDiv.textContent = ayah.sura_name_ar;
        quranTextDiv.appendChild(suraHeaderDiv);

        if (
          surahsStartingOnPage.has(ayah.sura_no) &&
          ayah.sura_no !== SURAH_NO_BASMALA &&
          !(state.currentRiwaya === 'hafs' && ayah.sura_no === 1)
        ) {
          const basmalaDiv = document.createElement('div');
          basmalaDiv.className = 'basmala';
          basmalaDiv.textContent = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
          quranTextDiv.appendChild(basmalaDiv);
        }
      }
    }

    const ayahSpan = document.createElement('span');
    ayahSpan.className = 'ayah';
    ayahSpan.dataset.sura = ayah.sura_no;
    ayahSpan.dataset.ayah = ayah.aya_no;
    ayahSpan.dataset.id = ayah.id;
    ayahSpan.textContent = ayah.aya_text + ' ' + ayah.aya_no_marker || '' + ' ';
    ayahSpan.addEventListener('click', (e) =>
      handleAyahClickWithToggle(e, ayah),
    );
    quranTextDiv.appendChild(ayahSpan);
  });

  const firstAyahOfCurrentSura = pageData.find(
    (a) => a.sura_no === state.currentSura,
  );
  updatePageInfo(firstAyahOfCurrentSura || pageData[0]);

  getEl('page-select').value = pageNum;

  if (!keepCurrentSura) {
    state.currentSura = pageData[0].sura_no;
    getEl('surah-select').value = state.currentSura;
    saveSetting('currentSura', state.currentSura);
  }

  state.currentJuz = pageData[0].jozz;
  getEl('juz-select').value = state.currentJuz;
  saveSetting('currentJuz', state.currentJuz);

  populateAyahSelector(state.currentSura);

  getEl('prev-page').disabled = state.currentPage === 1;
  getEl('next-page').disabled = state.currentPage === TOTAL_PAGES;
}

function updatePageInfo(pageData) {
  getEl('sura-title').textContent = pageData.sura_name_ar;
  getEl('page-info').textContent =
    `الجزء ${pageData.jozz} - صفحة ${state.currentPage}`;
}

// ─── Ayah Selection ───────────────────────────────────────────────────────────

async function restoreSavedAyah(suraNo, ayahNo) {
  const ayahData = await getAyahBySuraAndAya(suraNo, ayahNo);
  if (!ayahData) return;

  state.currentAyah = ayahData;
  state.currentSura = suraNo;

  getEl('surah-select').value = suraNo;
  populateAyahSelector(suraNo);
  getEl('ayah-select').value = ayahNo;
  updatePageInfo(ayahData);
  activateAyahInDOM(suraNo, ayahNo);
  updateNavButtonStates();
}

function setCurrentAyah(ayahData, { play = false } = {}) {
  state.currentAyah = ayahData;
  state.currentSura = ayahData.sura_no;

  getEl('surah-select').value = ayahData.sura_no;
  getEl('ayah-select').value = ayahData.aya_no;
  updatePageInfo(ayahData);

  saveSetting('currentSura', ayahData.sura_no);
  saveSetting('currentAyah', ayahData.aya_no);

  activateAyahInDOM(ayahData.sura_no, ayahData.aya_no);
  updateNavButtonStates();

  if (play) playAudio();
}

function selectAndPlayAyah(ayahData) {
  if (state.isPlaying) stopAudio();
  setCurrentAyah(ayahData, { play: true });
}

function handleAyahClickWithToggle(e, ayah) {
  const isSameAyah =
    state.currentAyah &&
    state.currentAyah.sura_no === ayah.sura_no &&
    state.currentAyah.aya_no === ayah.aya_no;

  if (isSameAyah) {
    togglePauseResume();
  } else {
    state.currentAyah = ayah;
    state.currentSura = ayah.sura_no;

    getEl('surah-select').value = ayah.sura_no;
    getEl('ayah-select').value = ayah.aya_no;
    updatePageInfo(ayah);
    saveSetting('currentSura', ayah.sura_no);
    saveSetting('currentAyah', ayah.aya_no);
    activateAyahInDOM(ayah.sura_no, ayah.aya_no);
    updateNavButtonStates();

    if (state.audioPlayer) {
      state.audioPlayer.pause();
      state.audioPlayer.src = '';
    }
    state.isPlaying = false;
    state.currentRepeatCount = 0;
    state.currentPlayModeRepeatCount = 0;

    setTimeout(() => playAudio(), 100);
  }
}

function selectFirstAyahOfSurah(suraNo) {
  getAyahBySuraAndAya(suraNo, 1).then((firstAyah) => {
    if (!firstAyah) return;
    state.currentAyah = firstAyah;
    state.currentSura = suraNo;
    getEl('ayah-select').value = 1;
    updatePageInfo(firstAyah);
    saveSetting('currentAyah', 1);
    setTimeout(() => activateAyahInDOM(suraNo, 1), 100);
  });
}

// ─── Audio ────────────────────────────────────────────────────────────────────

function initializeAudioPlayer() {
  state.audioPlayer = getEl('audio-player');
  if (!state.audioPlayer) return;

  state.audioPlayer.addEventListener('ended', () => {
    state.currentRepeatCount++;
    const repeatControl = getEl('repeat-control').value;
    const maxRepeat =
      repeatControl === 'infinite' ? Infinity : parseInt(repeatControl);

    if (state.currentRepeatCount < maxRepeat) {
      state.audioPlayer.play();
    } else {
      state.currentRepeatCount = 0;
      state.currentPlayIndex++;

      if (state.currentPlayIndex < state.playQueue.length) {
        playNextInQueue();
      } else {
        state.currentPlayModeRepeatCount++;
        if (state.currentPlayModeRepeatCount < maxRepeat) {
          state.currentPlayIndex = 0;
          state.currentRepeatCount = 0;
          rebuildFullPlayQueue();
          playNextInQueue();
        } else {
          state.currentPlayModeRepeatCount = 0;
          stopAudio();
        }
      }
    }
  });

  state.audioPlayer.addEventListener('play', () => {
    state.isPlaying = true;
    highlightActiveAyah();
    updatePauseButton();
  });

  state.audioPlayer.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePauseButton();
  });
}

async function playAudio() {
  state.selectedReciter = getEl('reciter-select').value;

  if (!state.selectedReciter) {
    showToast('الرجاء اختيار القارئ');
    return;
  }
  if (!state.currentAyah) {
    showToast('الرجاء اختيار آية');
    return;
  }

  // Pre-load the audio chunk for the current surah before building the queue
  await loadAudioSurahChunk(state.selectedReciter, state.currentAyah.sura_no);
  // Background-load adjacent surahs
  prefetchAdjacentAudioChunks(state.selectedReciter, state.currentAyah.sura_no);

  const useLocal = await checkLocalAudioAvailable(
    state.selectedReciter,
    state.currentAyah.sura_no,
  );
  state.useLocalAudio = useLocal;

  buildPlayQueue();

  if (state.playQueue.length === 0) {
    showToast('لا توجد ملفات صوتية للتشغيل');
    return;
  }

  state.currentPlayIndex = 0;
  state.currentRepeatCount = 0;
  state.currentPlayModeRepeatCount = 0;

  playNextInQueue();
}

function buildPlayQueue() {
  state.playQueue = [];
  const playMode = getEl('play-mode').value;

  const sliceFromCurrent = (ayahs) => {
    const startIndex = state.currentAyah
      ? ayahs.findIndex((a) => a.id === state.currentAyah.id)
      : 0;
    return startIndex >= 0 ? ayahs.slice(startIndex) : ayahs;
  };

  switch (playMode) {
    case 'aya':
      if (state.currentAyah) state.playQueue.push(state.currentAyah);
      break;
    case 'page':
      state.playQueue = sliceFromCurrent(getAyahsOnPage(state.currentPage));
      break;
    case 'sura':
      state.playQueue = sliceFromCurrent(
        state.quranData.filter((item) => item.sura_no === state.currentSura),
      );
      break;
    case 'juz':
      state.playQueue = sliceFromCurrent(
        state.quranData.filter((item) => item.jozz === state.currentJuz),
      );
      break;
  }
}

function rebuildFullPlayQueue() {
  state.playQueue = [];
  const playMode = getEl('play-mode').value;

  switch (playMode) {
    case 'aya':
      if (state.currentAyah) state.playQueue.push(state.currentAyah);
      break;
    case 'page':
      state.playQueue = getAyahsOnPage(state.currentPage);
      break;
    case 'sura':
      state.playQueue = state.quranData.filter(
        (item) => item.sura_no === state.currentSura,
      );
      break;
    case 'juz':
      state.playQueue = state.quranData.filter(
        (item) => item.jozz === state.currentJuz,
      );
      break;
  }
}

async function playNextInQueue() {
  if (state.currentPlayIndex >= state.playQueue.length) {
    stopAudio();
    return;
  }

  const ayah = state.playQueue[state.currentPlayIndex];
  state.selectedReciter = getEl('reciter-select')?.value || '';

  // Check/update local audio availability for this surah
  const cacheKey = `${state.selectedReciter}/${ayah.sura_no}`;
  if (!(cacheKey in state.localAudioCache)) {
    checkLocalAudioAvailable(state.selectedReciter, ayah.sura_no).then((ok) => {
      state.useLocalAudio = ok;
    });
  } else {
    state.useLocalAudio = state.localAudioCache[cacheKey];
  }

  let audioSrc;
  if (state.useLocalAudio) {
    audioSrc = buildAudioPath(state.selectedReciter, ayah.sura_no, ayah.aya_no);
  } else {
    // getFallbackAudioUrl is now async
    audioSrc =
      (await getFallbackAudioUrl(
        state.selectedReciter,
        ayah.sura_no,
        ayah.aya_no,
      )) || buildAudioPath(state.selectedReciter, ayah.sura_no, ayah.aya_no);
  }

  if (state.audioPlayer) {
    state.audioPlayer.src = audioSrc;
    state.audioPlayer.playbackRate = parseFloat(
      getEl('speed-control')?.value || '1',
    );
    state.audioPlayer.play().catch((error) => {
      console.error('Error playing audio:', error);
      state.currentRepeatCount = 0;
      state.currentPlayIndex++;
      if (state.currentPlayIndex < state.playQueue.length) playNextInQueue();
    });
  }

  state.currentAyah = ayah;
  state.currentSura = ayah.sura_no;
  saveSetting('currentAyah', ayah.aya_no);
  saveSetting('currentSura', ayah.sura_no);

  updateSidebarSelectors();
  updatePageInfo(ayah);
  highlightActiveAyah();
  updateNavButtonStates();

  const ayahElement = document.querySelector(
    `[data-sura="${ayah.sura_no}"][data-ayah="${ayah.aya_no}"]`,
  );

  if (ayahElement) {
    ayahElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    const ayahPage = parseInt(ayah.page.split('-')[0]);
    if (ayahPage !== state.currentPage) {
      displayPage(ayahPage, true).then(() => {
        const el = activateAyahInDOM(ayah.sura_no, ayah.aya_no);
        if (el) updateSidebarSelectors();
      });
    }
  }
}

function highlightActiveAyah() {
  if (state.currentAyah)
    activateAyahInDOM(state.currentAyah.sura_no, state.currentAyah.aya_no);
}

async function jumpToFirstAyahOfPage(pageNum, shouldPlay = false) {
  const pageData = await loadPageChunk(pageNum);
  if (pageData.length === 0) return;

  const firstAyah = pageData[0];

  if (state.audioPlayer) {
    state.audioPlayer.pause();
    state.audioPlayer.src = '';
  }
  state.isPlaying = false;
  state.playQueue = [];
  state.currentPlayIndex = 0;
  state.currentRepeatCount = 0;
  state.currentPlayModeRepeatCount = 0;

  state.currentAyah = firstAyah;
  state.currentSura = firstAyah.sura_no;
  state.currentJuz = firstAyah.jozz;

  getEl('surah-select').value = firstAyah.sura_no;
  getEl('juz-select').value = firstAyah.jozz;
  getEl('page-select').value = pageNum;
  populateAyahSelector(firstAyah.sura_no);
  getEl('ayah-select').value = firstAyah.aya_no;

  saveSetting('currentAyah', firstAyah.aya_no);
  saveSetting('currentSura', firstAyah.sura_no);
  saveSetting('currentJuz', firstAyah.jozz);

  updatePageInfo(firstAyah);

  setTimeout(() => {
    activateAyahInDOM(firstAyah.sura_no, firstAyah.aya_no);
    updateNavButtonStates();
    if (shouldPlay && getEl('reciter-select').value) playAudio();
  }, 100);
}

function hasActiveAudioSrc() {
  return !!(
    state.audioPlayer?.src &&
    state.audioPlayer.src !== '' &&
    state.audioPlayer.src !== window.location.href
  );
}

function clearAudioForNavigation() {
  if (state.audioPlayer) {
    state.audioPlayer.pause();
    state.audioPlayer.src = '';
  }
  state.isPlaying = false;
  state.playQueue = [];
  state.currentPlayIndex = 0;
  state.currentRepeatCount = 0;
  state.currentPlayModeRepeatCount = 0;
  updatePauseButton();
  syncBottomPlayIcon();
}

function stopAudio() {
  if (state.audioPlayer) {
    state.audioPlayer.pause();
    state.audioPlayer.currentTime = 0;
    state.audioPlayer.src = '';
  }
  state.isPlaying = false;
  state.currentPlayIndex = 0;
  state.currentRepeatCount = 0;
  state.currentPlayModeRepeatCount = 0;
  state.playQueue = [];

  updatePauseButton();
  syncBottomPlayIcon();
  clearProgressHideTimeout();
  stopProgressRAF();
  setAudioProgressActive(false);
  setAudioProgress(0);
}

function togglePauseResume() {
  if (!state.audioPlayer) return;

  const hasSrc =
    state.audioPlayer.src &&
    state.audioPlayer.src !== '' &&
    state.audioPlayer.src !== window.location.href;
  if (!hasSrc) {
    if (state.currentAyah) playAudio();
    return;
  }

  if (state.audioPlayer.paused) {
    state.audioPlayer.play().catch(() => {
      if (state.currentAyah) playAudio();
    });
  } else {
    state.audioPlayer.pause();
  }
}

function updatePauseButton() {
  const pauseBtn = getEl('pause-btn');
  const isPaused = state.audioPlayer?.paused ?? true;
  const html =
    isPaused || !state.isPlaying
      ? '<i class="bi bi-play-fill"></i> استئناف'
      : '<i class="bi bi-pause-fill"></i> إيقاف مؤقت';
  if (pauseBtn) pauseBtn.innerHTML = html;
}

async function changeReciterDuringPlayback(newReciter) {
  if (!state.currentAyah || !state.audioPlayer) return;

  const isActivelyPlaying = !state.audioPlayer.paused;
  const isPaused = state.audioPlayer.paused && hasActiveAudioSrc();
  if (!isActivelyPlaying && !isPaused) return;

  const ayah = state.playQueue[state.currentPlayIndex] ?? state.currentAyah;
  const useLocal = await checkLocalAudioAvailable(newReciter, ayah.sura_no);
  state.useLocalAudio = useLocal;

  const audioSrc = useLocal
    ? buildAudioPath(newReciter, ayah.sura_no, ayah.aya_no)
    : (await getFallbackAudioUrl(newReciter, ayah.sura_no, ayah.aya_no)) ||
      buildAudioPath(newReciter, ayah.sura_no, ayah.aya_no);

  state.audioPlayer.src = audioSrc;
  state.audioPlayer.playbackRate = parseFloat(
    getEl('speed-control')?.value || '1',
  );

  if (isActivelyPlaying) {
    state.audioPlayer.play().catch((error) => {
      console.error('Error playing audio with new reciter:', error);
    });
  }
}

function changeSpeed(direction) {
  const speedSelect = getEl('speed-control');
  const options = Array.from(speedSelect.options).map((o) =>
    parseFloat(o.value),
  );
  const currentIndex = options.indexOf(parseFloat(speedSelect.value));
  const newIndex = Math.max(
    0,
    Math.min(options.length - 1, currentIndex + direction),
  );
  if (newIndex === currentIndex) return;

  const newSpeed = options[newIndex];
  speedSelect.value = String(newSpeed);
  if (state.audioPlayer) state.audioPlayer.playbackRate = newSpeed;
  saveSetting('speed', String(newSpeed));

  speedSelect.style.transition = 'background-color 0.2s';
  speedSelect.style.backgroundColor = '#c8a96e44';
  setTimeout(() => (speedSelect.style.backgroundColor = ''), 400);

  syncBottomSpeedLabel();
}

async function navigateToAyah(ayahData) {
  const targetPage = parseInt(ayahData.page.split('-')[0]);
  const wasPlaying = state.isPlaying;
  const wasPaused = !wasPlaying && hasActiveAudioSrc();

  if (wasPlaying) stopAudio();
  else if (wasPaused) clearAudioForNavigation();

  if (targetPage !== state.currentPage) {
    await displayPage(targetPage, true);
    setTimeout(() => {
      setCurrentAyah(ayahData, { play: wasPlaying });
      populateAyahSelector(ayahData.sura_no);
      getEl('surah-select').value = ayahData.sura_no;
      getEl('ayah-select').value = ayahData.aya_no;
    }, 150);
  } else {
    if (ayahData.sura_no !== state.currentSura) {
      populateAyahSelector(ayahData.sura_no);
      getEl('surah-select').value = ayahData.sura_no;
    }
    setCurrentAyah(ayahData, { play: wasPlaying });
    getEl('ayah-select').value = ayahData.aya_no;
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function initializeEventListeners() {
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) {
    riwayaSelect.addEventListener('change', (e) =>
      switchRiwaya(e.target.value),
    );
  }

  // Surah selector
  getEl('surah-select').addEventListener('change', async (e) => {
    if (state.isSwitchingRiwaya) return;
    const suraNo = parseInt(e.target.value);
    state.currentSura = suraNo;

    const pageNum =
      parseInt(state.quranIndex?.sura_to_page?.[String(suraNo)]) || 1;
    await displayPage(pageNum, true);
    getEl('surah-select').value = suraNo;
    populateAyahSelector(suraNo);

    const firstAyah = await getAyahBySuraAndAya(suraNo, 1);
    if (!firstAyah) return;

    state.currentAyah = firstAyah;
    saveSetting('currentSura', suraNo);
    saveSetting('currentAyah', firstAyah.aya_no);

    const wasPlaying = state.isPlaying;
    const wasPaused = !wasPlaying && hasActiveAudioSrc();
    if (wasPlaying) stopAudio();
    else if (wasPaused) clearAudioForNavigation();

    setTimeout(() => {
      activateAyahInDOM(suraNo, 1);
      getEl('ayah-select').value = 1;
      updatePageInfo(firstAyah);
      updateNavButtonStates();
      if (wasPlaying && getEl('reciter-select').value) playAudio();
    }, 100);
  });

  // Juz selector
  getEl('juz-select').addEventListener('change', async (e) => {
    if (state.isSwitchingRiwaya) return;
    const juzNo = parseInt(e.target.value);
    state.currentJuz = juzNo;
    saveSetting('currentJuz', juzNo);

    const pageNum =
      parseInt(state.quranIndex?.juz_to_page?.[String(juzNo)]) || 1;
    const wasPlaying = state.isPlaying;
    await displayPage(pageNum);
    jumpToFirstAyahOfPage(pageNum, wasPlaying);
  });

  // Page selector
  getEl('page-select').addEventListener('change', async (e) => {
    if (state.isSwitchingRiwaya) return;
    const pageNum = parseInt(e.target.value);
    const wasPlaying = state.isPlaying;
    await displayPage(pageNum);
    jumpToFirstAyahOfPage(pageNum, wasPlaying);
  });

  // Ayah selector
  getEl('ayah-select').addEventListener('change', async (e) => {
    const ayahNo = parseInt(e.target.value);
    if (!ayahNo) return;

    const ayahData = await getAyahBySuraAndAya(state.currentSura, ayahNo);
    if (!ayahData) return;

    const wasPlaying = state.isPlaying;
    const wasPaused = !wasPlaying && hasActiveAudioSrc();
    const ayahPage = parseInt(ayahData.page.split('-')[0]);

    if (ayahPage !== state.currentPage) {
      await displayPage(ayahPage, true);
      setTimeout(() => {
        if (wasPlaying) selectAndPlayAyah(ayahData);
        else {
          if (wasPaused) clearAudioForNavigation();
          setCurrentAyah(ayahData);
        }
      }, 200);
    } else {
      if (wasPlaying) selectAndPlayAyah(ayahData);
      else {
        if (wasPaused) clearAudioForNavigation();
        setCurrentAyah(ayahData);
      }
    }
  });

  // Reciter selector
  getEl('reciter-select').addEventListener('change', (e) => {
    const newReciter = e.target.value;
    state.selectedReciter = newReciter;
    saveSetting('reciter', newReciter);
    changeReciterDuringPlayback(newReciter);
  });

  // Speed control
  getEl('speed-control').addEventListener('change', (e) => {
    const speed = e.target.value;
    if (state.audioPlayer) state.audioPlayer.playbackRate = parseFloat(speed);
    saveSetting('speed', speed);
  });

  // Repeat control
  getEl('repeat-control').addEventListener('change', (e) =>
    saveSetting('repeat', e.target.value),
  );

  // Play mode
  getEl('play-mode').addEventListener('change', (e) =>
    saveSetting('playMode', e.target.value),
  );

  // Font size
  getEl('font-size-control').addEventListener('change', (e) => {
    applyFontSize(e.target.value);
    saveSetting('fontSize', e.target.value);
  });

  // Page navigation buttons
  getEl('prev-page').addEventListener('click', () => {
    if (state.currentPage > 1) {
      const newPage = state.currentPage - 1;
      const wasPlaying = state.isPlaying;
      displayPage(newPage).then(() =>
        jumpToFirstAyahOfPage(newPage, wasPlaying),
      );
    }
  });

  getEl('next-page').addEventListener('click', () => {
    if (state.currentPage < TOTAL_PAGES) {
      const newPage = state.currentPage + 1;
      const wasPlaying = state.isPlaying;
      displayPage(newPage).then(() =>
        jumpToFirstAyahOfPage(newPage, wasPlaying),
      );
    }
  });

  // Playback buttons
  getEl('play-btn').addEventListener('click', playAudio);
  getEl('pause-btn').addEventListener('click', togglePauseResume);
  getEl('stop-btn').addEventListener('click', stopAudio);

  // Keyboard shortcuts
  document.addEventListener('keydown', async (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    if (e.code === 'Space') {
      e.preventDefault();
      const hasAudio = state.audioPlayer?.src && state.audioPlayer.src !== '';
      if (hasAudio) togglePauseResume();
      else if (state.currentAyah) playAudio();
      return;
    }

    const numMatch = e.code.match(/^(?:Digit|Numpad)([0-9])$/);
    if (
      numMatch &&
      state.audioPlayer?.src &&
      state.audioPlayer.src !== '' &&
      state.audioPlayer.duration
    ) {
      e.preventDefault();
      state.audioPlayer.currentTime =
        state.audioPlayer.duration * (parseInt(numMatch[1]) / 10);
      return;
    }

    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      if (state.currentAyah) {
        const nextAyah = await getAyahBySuraAndAya(
          state.currentAyah.sura_no,
          state.currentAyah.aya_no + 1,
        );
        if (nextAyah) {
          navigateToAyah(nextAyah);
        } else {
          const nextFirst = await getAyahBySuraAndAya(
            state.currentAyah.sura_no + 1,
            1,
          );
          if (nextFirst) navigateToAyah(nextFirst);
        }
      }
      return;
    }

    if (e.code === 'ArrowRight') {
      e.preventDefault();
      if (state.currentAyah) {
        const prevAyah = await getAyahBySuraAndAya(
          state.currentAyah.sura_no,
          state.currentAyah.aya_no - 1,
        );
        if (prevAyah) {
          navigateToAyah(prevAyah);
        } else if (state.currentAyah.sura_no > 1) {
          // Last ayah of previous surah — need its count from index
          const prevSuraInfo =
            state.quranIndex?.sura_info?.[
              String(state.currentAyah.sura_no - 1)
            ];
          if (prevSuraInfo) {
            const lastAyah = await getAyahBySuraAndAya(
              state.currentAyah.sura_no - 1,
              prevSuraInfo.ayah_count,
            );
            if (lastAyah) navigateToAyah(lastAyah);
          }
        }
      }
      return;
    }

    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault();
      changeSpeed(1);
      return;
    }
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      changeSpeed(-1);
      return;
    }
  });
}

// ── Speed-dial FAB ──
const fabDial = document.getElementById('fab-speed-dial');
const fabTrigger = document.getElementById('fab-trigger');
function toggleFab() {
  const isOpen = fabDial.classList.toggle('open');
  fabTrigger.setAttribute('aria-expanded', isOpen);
}
function closeFab() {
  fabDial.classList.remove('open');
  fabTrigger.setAttribute('aria-expanded', 'false');
}
document
  .getElementById('fab-sidebar-btn')
  .addEventListener('click', function () {
    closeFab();
    bootstrap.Offcanvas.getOrCreateInstance(
      document.getElementById('offcanvasSidebar'),
    ).show();
  });
document.getElementById('fab-about-btn').addEventListener('click', function () {
  closeFab();
  bootstrap.Modal.getOrCreateInstance(
    document.getElementById('aboutModal'),
  ).show();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeFab();
});

// ── Theme Toggle ──
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  updateThemeUI(isLight);
}

function updateThemeUI(isLight) {
  const icon = document.getElementById('theme-icon');
  const text = document.getElementById('theme-text');
  const fabIcon = document.getElementById('fab-theme-icon');
  if (icon)
    icon.className = isLight ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
  if (text) text.textContent = isLight ? 'الوضع النهاري' : 'الوضع الليلي';
  if (fabIcon)
    fabIcon.className = isLight ? 'bi bi-sun-fill' : 'bi bi-moon-stars-fill';
}

(function () {
  let saved = localStorage.getItem('theme');
  if (!saved) {
    saved = 'light';
    localStorage.setItem('theme', 'light');
  }
  const isLight = saved === 'light';
  if (isLight) document.body.classList.add('light-mode');
  updateThemeUI(isLight);
})();

// ─── Settings ─────────────────────────────────────────────────────────────────

function loadSettings() {
  const savedSpeed = localStorage.getItem('speed') || '1';
  getEl('speed-control').value = savedSpeed;

  const savedRepeat = localStorage.getItem('repeat') || '1';
  getEl('repeat-control').value = savedRepeat;

  const savedPlayMode = localStorage.getItem('playMode') || 'sura';
  getEl('play-mode').value = savedPlayMode;

  const savedFontSize = localStorage.getItem('fontSize') || '28';
  getEl('font-size-control').value = savedFontSize;
  applyFontSize(savedFontSize);

  setTimeout(() => showWarshModal(), 2000);
}

// ─── Bottom Controls Bar ──────────────────────────────────────────────────────

function syncBottomSpeedLabel() {
  const sel = getEl('speed-control');
  const label = getEl('bottom-speed-label');
  if (sel && label) label.textContent = parseFloat(sel.value) + 'x';
}

function syncBottomPlayIcon() {
  const icon = getEl('bottom-play-icon');
  if (!icon) return;
  icon.className = state.isPlaying ? 'bi bi-pause-fill' : 'bi bi-play-fill';
}

function updateNavButtonStates() {
  const prevSurahBtn = document.querySelector(
    '.ctrl-btn[onclick="bottomNavPrevSurah()"]',
  );
  const prevAyahBtn = document.querySelector(
    '.ctrl-btn[onclick="bottomNavPrev()"]',
  );
  const nextAyahBtn = document.querySelector(
    '.ctrl-btn[onclick="bottomNavNext()"]',
  );
  const nextSurahBtn = document.querySelector(
    '.ctrl-btn[onclick="bottomNavNextSurah()"]',
  );

  if (!state.currentAyah) {
    [prevSurahBtn, prevAyahBtn, nextAyahBtn, nextSurahBtn].forEach((b) => {
      if (b) b.disabled = true;
    });
    return;
  }

  const sura = state.currentAyah.sura_no;
  const aya = state.currentAyah.aya_no;
  const suraInfo = state.quranIndex?.sura_info?.[String(sura)];
  const ayahCount = suraInfo?.ayah_count || 0;

  const hasPrevAyah = aya > 1;
  const hasPrevSurah = sura > 1;
  const hasNextAyah = aya < ayahCount || sura < 114;
  const hasNextSurah = sura < 114;

  if (prevAyahBtn) prevAyahBtn.disabled = !hasPrevAyah && !hasPrevSurah;
  if (prevSurahBtn) prevSurahBtn.disabled = !hasPrevSurah;
  if (nextAyahBtn) nextAyahBtn.disabled = !hasNextAyah;
  if (nextSurahBtn) nextSurahBtn.disabled = !hasNextSurah;
}

function bottomPlayPause() {
  const hasAudio = state.audioPlayer?.src && state.audioPlayer.src !== '';
  if (hasAudio) togglePauseResume();
  else if (state.currentAyah) playAudio();
  setTimeout(syncBottomPlayIcon, 100);
}

function bottomNavNext() {
  if (!state.currentAyah) return;
  const sura = state.currentAyah.sura_no;
  const aya = state.currentAyah.aya_no;
  const suraInfo = state.quranIndex?.sura_info?.[String(sura)];

  if (suraInfo && aya < suraInfo.ayah_count) {
    getAyahBySuraAndAya(sura, aya + 1).then((next) => {
      if (next) navigateToAyah(next);
    });
  } else {
    getAyahBySuraAndAya(sura + 1, 1).then((next) => {
      if (next) navigateToAyah(next);
    });
  }
}

function bottomNavPrev() {
  if (!state.currentAyah) return;
  const sura = state.currentAyah.sura_no;
  const aya = state.currentAyah.aya_no;

  if (aya > 1) {
    getAyahBySuraAndAya(sura, aya - 1).then((prev) => {
      if (prev) navigateToAyah(prev);
    });
  } else if (sura > 1) {
    const prevSuraInfo = state.quranIndex?.sura_info?.[String(sura - 1)];
    if (prevSuraInfo) {
      getAyahBySuraAndAya(sura - 1, prevSuraInfo.ayah_count).then((prev) => {
        if (prev) navigateToAyah(prev);
      });
    }
  }
}

function bottomNavPrevSurah() {
  if (!state.currentAyah || state.currentAyah.sura_no <= 1) return;
  getAyahBySuraAndAya(state.currentAyah.sura_no - 1, 1).then((a) => {
    if (a) navigateToAyah(a);
  });
}

function bottomNavNextSurah() {
  if (!state.currentAyah || state.currentAyah.sura_no >= 114) return;
  getAyahBySuraAndAya(state.currentAyah.sura_no + 1, 1).then((a) => {
    if (a) navigateToAyah(a);
  });
}

function initializeBottomControls() {
  syncBottomSpeedLabel();
  const player = getEl('audio-player');
  if (player) {
    player.addEventListener('play', () => {
      setTimeout(syncBottomPlayIcon, 50);
      clearProgressHideTimeout();
      setAudioProgressActive(true);
      startProgressRAF();
    });
    player.addEventListener('pause', () => {
      setTimeout(syncBottomPlayIcon, 50);
      stopProgressRAF();
      setAudioProgressActive(false);
    });
    player.addEventListener('ended', () => {
      setTimeout(syncBottomPlayIcon, 50);
      stopProgressRAF();
      setAudioProgress(1);
      _progressHideTimeoutId = setTimeout(() => {
        setAudioProgressActive(false);
        setAudioProgress(0);
      }, 300);
    });
    player.addEventListener('emptied', () => {
      clearProgressHideTimeout();
      stopProgressRAF();
      setAudioProgressActive(false);
      setAudioProgress(0);
    });
  }
  const speedSel = getEl('speed-control');
  if (speedSel) speedSel.addEventListener('change', syncBottomSpeedLabel);
}

// ─── Audio progress RAF helpers ───────────────────────────────────────────────

let _progressRAFId = null;
let _progressHideTimeoutId = null;

function clearProgressHideTimeout() {
  if (_progressHideTimeoutId !== null) {
    clearTimeout(_progressHideTimeoutId);
    _progressHideTimeoutId = null;
  }
}

function startProgressRAF() {
  stopProgressRAF();
  const player = getEl('audio-player');
  if (!player) return;
  function frame() {
    if (player.duration > 0)
      setAudioProgress(player.currentTime / player.duration);
    _progressRAFId = requestAnimationFrame(frame);
  }
  _progressRAFId = requestAnimationFrame(frame);
}

function stopProgressRAF() {
  if (_progressRAFId !== null) {
    cancelAnimationFrame(_progressRAFId);
    _progressRAFId = null;
  }
}

function setAudioProgressActive(active) {
  const strip = getEl('audio-progress-strip');
  if (strip) strip.classList.toggle('is-playing', active);
}

function setAudioProgress(ratio) {
  const fill = getEl('audio-progress-fill');
  if (fill) fill.style.width = (Math.min(ratio, 1) * 100).toFixed(3) + '%';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
  document.body.classList.toggle('fullscreen-mode');
}

function startWarshModalTimer() {
  const bar = document.getElementById('warshProgressBar');
  const countdown = document.getElementById('warshCountdown');
  const closeBtn = document.getElementById('warshCloseBtn');
  const label = document.getElementById('warshTimerLabel');
  if (!bar || !closeBtn) return;

  let remaining = WARSH_TIMER_MS / 1000;
  requestAnimationFrame(() => {
    bar.style.width = '100%';
    requestAnimationFrame(() => {
      bar.style.transition = `width ${WARSH_TIMER_MS}ms linear`;
      bar.style.width = '0%';
    });
  });

  const tick = setInterval(() => {
    remaining--;
    if (countdown) countdown.textContent = Math.max(remaining, 0);
    if (remaining <= 0) {
      clearInterval(tick);
      closeBtn.classList.remove('disabled');
      closeBtn.removeAttribute('disabled');
      if (label) label.textContent = '';
    }
  }, 1000);
}

function showWarshModal() {
  if (localStorage.getItem(WARSH_MODAL_KEY) === '1') return;
  if (state.currentRiwaya !== 'warsh') return;

  const modalEl = document.getElementById('warshInfoModal');
  if (!modalEl) return;

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl, {
    backdrop: 'static',
    keyboard: false,
  });

  const bar = document.getElementById('warshProgressBar');
  const btn = document.getElementById('warshCloseBtn');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '100%';
  }
  if (btn) btn.classList.add('disabled');

  modalEl.addEventListener(
    'hidden.bs.modal',
    () => {
      localStorage.setItem(WARSH_MODAL_KEY, '1');
    },
    { once: true },
  );
  modal.show();
  modalEl.addEventListener(
    'shown.bs.modal',
    () => {
      const b = document.getElementById('warshProgressBar');
      if (b) b.style.transition = '';
      startWarshModalTimer();
    },
    { once: true },
  );
}
