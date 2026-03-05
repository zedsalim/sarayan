// ─── Constants ────────────────────────────────────────────────────────────────
const TOTAL_PAGES = 604;
const SURAH_NO_BASMALA = 9; // Surah At-Tawbah has no Basmala
const WARSH_MODAL_KEY = 'warshModalSeen';
const WARSH_TIMER_MS = 5000;

// mp3quran API base
const MP3QURAN_API = 'https://www.mp3quran.net/api/v3';

// ─── TEMPORARY DEBUG HELPER ───────────────────────────────────────────────────
// To disable: set DEBUG = false   |   To remove entirely: delete this whole
// block (lines between the two ─── markers) AND the 4 CONSOLE_LOG.xxx() call
// sites inside fetchReciters, fetchTimingReads, fetchSurahTiming, and
// _playQueueItemAtIndex.  Nothing else depends on this object.
const DEBUG = true;

const CONSOLE_LOG = (() => {
  const noop = () => {};
  if (!DEBUG)
    return {
      reciters: noop,
      timingReads: noop,
      surahTiming: noop,
      playingAyah: noop,
    };

  const ms = (t) => `${(t / 1000).toFixed(2)}s`;

  return {
    /** After reciters are fetched — shows id, name, server URL, moshaf_type, surah count */
    reciters(riwayaKey, cfg, reciters) {
      console.group(
        `%c[API] Reciters  riwaya="${riwayaKey}" (rewayaId=${cfg.rewayaId})  →  ${reciters.length} reciter(s)`,
        'color:#1565c0;font-weight:bold',
      );
      reciters.forEach((r) => {
        const m = r.moshaf?.[0] ?? {};
        console.log(
          `  #${String(r.id).padEnd(4)} ${r.name}\n` +
            `         server      : ${m.server ?? '—'}\n` +
            `         moshaf_type : ${m.moshaf_type ?? '—'}\n` +
            `         surahs      : ${m.surah_total ?? '—'} / 114`,
        );
      });
      console.groupEnd();
    },

    /** After timing-reads are fetched — shows which reciters support ayah-by-ayah timing */
    timingReads(reads) {
      console.group(
        `%c[API] Timing reads  →  ${reads.length} reciter(s) with ayah timing`,
        'color:#6a1b9a;font-weight:bold',
      );
      reads.forEach((r) => {
        console.log(
          `  #${String(r.id).padEnd(4)} ${r.name}\n` +
            `         rewaya      : ${r.rewaya}\n` +
            `         folder_url  : ${r.folder_url}\n` +
            `         surahs      : ${r.soar_count}`,
        );
      });
      console.groupEnd();
    },

    /** After surah timing is fetched — shows first 5 ayah windows */
    surahTiming(readId, suraNo, timing) {
      if (!timing || timing.length === 0) {
        console.warn(
          `%c[API] Timing  read=#${readId}  surah=${suraNo}  →  NO DATA`,
          'color:#b71c1c',
        );
        return;
      }
      console.group(
        `%c[API] Timing  read=#${readId}  surah=${suraNo}  →  ${timing.length} ayah(s)`,
        'color:#2e7d32;font-weight:bold',
      );
      const preview = timing.slice(0, 5);
      preview.forEach((t) =>
        console.log(
          `  ayah ${String(t.ayah).padStart(3)}  :  ${ms(t.start_time)}  →  ${ms(t.end_time)}  (${ms(t.end_time - t.start_time)})`,
        ),
      );
      if (timing.length > 5)
        console.log(`  … and ${timing.length - 5} more ayahs`);
      console.groupEnd();
    },

    /** When an ayah starts playing — shows reciter, surah URL, seek window */
    playingAyah(reciter, riwayaKey, ayah, surahUrl, ayahTiming) {
      const hasTiming = !!ayahTiming;
      console.group(
        `%c[PLAY]  ${riwayaKey}  |  Surah ${ayah.sura_no} : Ayah ${ayah.aya_no}  |  ${reciter?.name ?? '?'}`,
        `color:${hasTiming ? '#004d40' : '#e65100'};font-weight:bold`,
      );
      console.log(`  reciter id  : ${reciter?.id ?? '—'}`);
      console.log(`  riwaya      : ${riwayaKey}`);
      console.log(`  surah URL   : ${surahUrl}`);
      if (hasTiming) {
        console.log(
          `  seek        : ${ms(ayahTiming.start_time)}  →  ${ms(ayahTiming.end_time)}` +
            `  (duration: ${ms(ayahTiming.end_time - ayahTiming.start_time)})`,
        );
      } else {
        console.log(
          '  timing      : ✗ — playing full surah (no ayah-level timing)',
        );
      }
      console.groupEnd();
    },
  };
})();
// ─── END TEMPORARY DEBUG HELPER ───────────────────────────────────────────────

/**
 * Riwaya configuration.
 * rewayaId    : the id used in mp3quran API ?rewaya= query parameter
 * moshafType  : the moshaf_type value inside each reciter's moshaf array
 *               (different from rewayaId — confirmed from live API responses)
 * font        : CSS font-family name to apply when this riwaya is active
 *
 * Confirmed moshaf_type values from API:
 *   Warsh A'n Nafi' Murattal  → 21
 *   Hafs A'n Assem  Murattal  → 116  (most common), also 11
 */
const RIWAYA_CONFIG = {
  warsh: {
    textFile: 'assets/text/warsh-quran.min.json',
    rewayaId: 2, // used in ?rewaya=2
    moshafType: 21, // moshaf_type in API response
    font: 'UthmanicWarsh',
  },
  hafs: {
    textFile: 'assets/text/hafs-quran.min.json',
    rewayaId: 1, // used in ?rewaya=1
    moshafType: 116, // moshaf_type in API response (most common for Hafs)
    font: 'UthmanicHafs',
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  quranData: [],
  reciters: [], // fetched from mp3quran API
  timingReads: [], // fetched from /ayat_timing/reads — reciters that have timing
  timingCache: {}, // cache: key = `{moshafId}_{suraNo}` → array of ayah timing objects
  currentPage: 1,
  currentSura: 1,
  currentJuz: 1,
  currentAyah: null,
  currentRiwaya: 'warsh',
  selectedReciter: null, // full reciter object { id, name, moshaf: [{server,...}] }
  audioPlayer: null,
  playQueue: [], // array of ayah data objects
  currentPlayIndex: 0,
  repeatCount: 1,
  currentRepeatCount: 0,
  currentPlayModeRepeatCount: 0,
  isPlaying: false,
  isSwitchingRiwaya: false,
  // Timing-based playback state
  currentSurahTiming: [], // timing array for the currently loaded surah
  currentAyahEndTime: null, // end_time (ms) for the ayah currently playing
  timingWatcherId: null, // setInterval id for timeupdate polling
  _noTimingToastKey: null, // `${reciterId}_${suraNo}` — fires once per reciter+surah
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

function getAyahsOnPage(pageNum) {
  return state.quranData.filter((item) => {
    const pages = item.page.split('-');
    return pages.some((p) => parseInt(p.trim()) === pageNum);
  });
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

/**
 * Build the streaming audio URL for a given ayah using the mp3quran reciter server.
 * mp3quran audio files follow the pattern: {server}/{surah_3digit}{ayah_3digit}.mp3
 */
/**
 * Build the surah MP3 URL for a given surah number.
 * mp3quran stores one file per surah: {server}{surah_3digit}.mp3
 * e.g. https://server11.mp3quran.net/qari/001.mp3
 *      https://server13.mp3quran.net/husr/Rewayat-Warsh-A-n-Nafi/018.mp3
 */
function buildSurahAudioUrl(suraNo) {
  if (!state.selectedReciter) return null;
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  const moshaf =
    state.selectedReciter.moshaf.find(
      (m) => m.moshaf_type === cfg.moshafType,
    ) || state.selectedReciter.moshaf[0];
  if (!moshaf) return null;
  const server = moshaf.server.endsWith('/')
    ? moshaf.server
    : moshaf.server + '/';
  return `${server}${String(suraNo).padStart(3, '0')}.mp3`;
}

/**
 * Return the moshaf object for the currently selected reciter + riwaya.
 */
function getSelectedMoshaf() {
  if (!state.selectedReciter) return null;
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  return (
    state.selectedReciter.moshaf.find(
      (m) => m.moshaf_type === cfg.moshafType,
    ) || state.selectedReciter.moshaf[0]
  );
}

/**
 * Check whether the selected reciter has a given surah available.
 */
function reciterHasSurah(reciter, suraNo) {
  if (!reciter) return false;
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  const moshaf =
    reciter.moshaf.find((m) => m.moshaf_type === cfg.moshafType) ||
    reciter.moshaf[0];
  if (!moshaf?.surah_list) return true;
  return moshaf.surah_list.split(',').map(Number).includes(suraNo);
}

// ─── Ayat Timing API ──────────────────────────────────────────────────────────

/**
 * Fetch the list of reads (reciters) that have ayat timing available.
 * Cached in state.timingReads after first fetch.
 */
async function fetchTimingReads() {
  if (state.timingReads.length > 0) return state.timingReads;
  try {
    const res = await fetch(`${MP3QURAN_API}/ayat_timing/reads`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.timingReads = Array.isArray(data) ? data : [];
    CONSOLE_LOG.timingReads(state.timingReads); // DEBUG — remove with CONSOLE_LOG block
  } catch (err) {
    console.warn('Could not fetch timing reads:', err);
    state.timingReads = [];
  }
  return state.timingReads;
}

/**
 * Find the timing read that matches the selected reciter's moshaf server URL.
 * The timing API uses its own `id` (read id) which we match via folder_url.
 * Returns the matching timing read object or null if not found.
 */
function findTimingRead() {
  const moshaf = getSelectedMoshaf();
  if (!moshaf || state.timingReads.length === 0) return null;

  // Normalize both URLs for comparison (strip trailing slash, lowercase)
  const normalize = (url) => url.replace(/\/$/, '').toLowerCase();
  const moshafServer = normalize(moshaf.server);

  return (
    state.timingReads.find((r) => normalize(r.folder_url) === moshafServer) ||
    null
  );
}

/**
 * Check whether a given reciter has ayat timing available.
 * Matches the reciter's moshaf server URL against the timing reads list.
 */
function reciterHasTiming(reciter) {
  if (!reciter || state.timingReads.length === 0) return false;
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  const moshaf =
    reciter.moshaf.find((m) => m.moshaf_type === cfg.moshafType) ||
    reciter.moshaf[0];
  if (!moshaf) return false;
  const normalize = (url) => url.replace(/\/$/, '').toLowerCase();
  const moshafServer = normalize(moshaf.server);
  return state.timingReads.some(
    (r) => normalize(r.folder_url) === moshafServer,
  );
}

/**
 * Fetch and cache ayat timing for a given read id + surah number.
 * Returns array of { ayah, start_time, end_time } objects, or null on failure.
 * Times are in milliseconds.
 */
async function fetchSurahTiming(readId, suraNo) {
  const cacheKey = `${readId}_${suraNo}`;
  if (state.timingCache[cacheKey]) return state.timingCache[cacheKey];

  try {
    const res = await fetch(
      `${MP3QURAN_API}/ayat_timing?surah=${suraNo}&read=${readId}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Filter out ayah=0 (pre-surah silence entry) and store
    const timing = Array.isArray(data) ? data.filter((t) => t.ayah > 0) : [];
    // Pull the first ayah's start time 0s for better sync
    if (timing.length > 0) {
      timing[0] = {
        ...timing[0],
        // start_time: Math.max(0, timing[0].start_time - 1000),
        start_time: 0,
      };
    }
    state.timingCache[cacheKey] = timing;
    CONSOLE_LOG.surahTiming(readId, suraNo, timing); // DEBUG — remove with CONSOLE_LOG block
    return timing;
  } catch (err) {
    console.warn(
      `Could not fetch timing for read=${readId} surah=${suraNo}:`,
      err,
    );
    return null;
  }
}

/**
 * Get the timing entry for a specific ayah from a timing array.
 */
function getAyahTiming(timingArray, ayahNo) {
  return timingArray.find((t) => t.ayah === ayahNo) || null;
}

function showToast(message, duration = 3000) {
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
  }, duration);
}

// ─── mp3quran API ─────────────────────────────────────────────────────────────

/**
 * Fetch reciters from mp3quran API for the current riwaya.
 * Returns array of reciter objects with their moshaf (includes server URL).
 */
async function fetchReciters(riwaya = state.currentRiwaya) {
  const cfg = RIWAYA_CONFIG[riwaya];
  if (!cfg) return [];
  try {
    const url = `${MP3QURAN_API}/reciters?language=ar&rewaya=${cfg.rewayaId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const reciters = data.reciters || [];
    CONSOLE_LOG.reciters(riwaya, cfg, reciters); // DEBUG — remove with CONSOLE_LOG block
    return reciters;
  } catch (err) {
    console.error('Failed to fetch reciters from mp3quran:', err);
    showToast('تعذّر تحميل أسماء القراء');
    return [];
  }
}

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const savedRiwaya = localStorage.getItem('riwaya') || 'warsh';
  state.currentRiwaya = savedRiwaya;
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) riwayaSelect.value = savedRiwaya;

  await loadQuranData();

  // Fetch reciters and timing reads in parallel
  showToast('جارٍ تحميل أسماء القراء...');
  [state.reciters, state.timingReads] = await Promise.all([
    fetchReciters(savedRiwaya),
    fetchTimingReads(),
  ]);

  initializeSelectors();
  initializeAudioPlayer();
  loadSettings();
  applyRiwayaFont();
  populateReciterOptions();
  initializeEventListeners();
  initializeBottomControls();

  const startPage = parseInt(localStorage.getItem('currentPage')) || 1;
  const savedSura = parseInt(localStorage.getItem('currentSura')) || 1;
  const savedAyah = parseInt(localStorage.getItem('currentAyah')) || null;

  displayPage(startPage, true);

  if (savedSura && savedAyah) {
    setTimeout(() => restoreSavedAyah(savedSura, savedAyah), 200);
  } else {
    setTimeout(() => {
      const firstAyah = state.quranData.find(
        (item) => item.sura_no === savedSura && item.aya_no === 1,
      );
      if (firstAyah) {
        state.currentAyah = firstAyah;
        state.currentSura = firstAyah.sura_no;
        populateAyahSelector(firstAyah.sura_no);
        getEl('ayah-select').value = 1;
        updatePageInfo(firstAyah);
        activateAyahInDOM(firstAyah.sura_no, 1);
        updateNavButtonStates();
      }
    }, 200);
  }
});

function restoreSavedAyah(suraNo, ayahNo) {
  const ayahData = state.quranData.find(
    (item) => item.sura_no === suraNo && item.aya_no === ayahNo,
  );
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

  setTimeout(() => {
    showWarshModal();
  }, 2000);
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadQuranData() {
  try {
    const cfg = RIWAYA_CONFIG[state.currentRiwaya];
    const textFile = cfg ? cfg.textFile : 'assets/text/warsh-quran.min.json';
    const response = await fetch(textFile);
    const raw = await response.json();
    state.quranData = raw.map((item) => ({ ...item, page: String(item.page) }));
  } catch (error) {
    console.error('Error loading Quran data:', error);
    showToast('خطأ في تحميل بيانات القرآن الكريم');
  }
}

function cycleRiwaya() {
  const riwayas = Object.keys(RIWAYA_CONFIG);
  const currentIdx = riwayas.indexOf(state.currentRiwaya);
  const nextRiwaya = riwayas[(currentIdx + 1) % riwayas.length];
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

/**
 * Populate the reciter <select> from the API-fetched reciters list.
 * Each option value is the reciter's numeric id.
 */
function populateReciterOptions() {
  const reciterSelect = getEl('reciter-select');
  if (!reciterSelect) return;

  reciterSelect.innerHTML = '<option value="">اختر القارئ</option>';

  const isWarsh = state.currentRiwaya === 'warsh';

  state.reciters
    .filter((reciter) => reciterHasTiming(reciter))
    .filter((reciter) => !(isWarsh && reciter.id === 134))
    .forEach((reciter) => {
      const opt = document.createElement('option');
      opt.value = reciter.id;
      opt.textContent = reciter.name;
      reciterSelect.appendChild(opt);
    });

  // Restore saved reciter id (only if they have timing)
  const savedId = localStorage.getItem('reciter') || '';
  const timedReciters = state.reciters
    .filter((r) => reciterHasTiming(r))
    .filter((r) => !(isWarsh && r.id === 134));
  const savedExists = timedReciters.find((r) => String(r.id) === savedId);
  const defaultId = savedExists
    ? savedId
    : timedReciters.length > 0
      ? String(timedReciters[0].id)
      : '';

  reciterSelect.value = defaultId;
  state.selectedReciter =
    state.reciters.find((r) => String(r.id) === defaultId) || null;
}

/**
 * Switch riwaya: stop audio, reload text + reciters, re-render.
 */
async function switchRiwaya(newRiwaya) {
  if (newRiwaya === state.currentRiwaya) return;
  const preservedSura = state.currentSura || 1;

  stopAudio();
  state.currentRiwaya = newRiwaya;
  saveSetting('riwaya', newRiwaya);
  state.reciters = [];
  state.selectedReciter = null;

  showToast('تحويل الرواية...');

  await loadQuranData();

  // Fetch new riwaya's reciters and timing reads
  [state.reciters, state.timingReads] = await Promise.all([
    fetchReciters(newRiwaya),
    fetchTimingReads(),
  ]);

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

  const firstAyah = state.quranData.find(
    (item) => item.sura_no === preservedSura && item.aya_no === 1,
  );

  if (firstAyah) {
    const targetPage = parseInt(firstAyah.page.split('-')[0]);
    displayPage(targetPage, true);
    getEl('surah-select').value = preservedSura;
    saveSetting('currentSura', preservedSura);
    setTimeout(() => {
      state.currentAyah = firstAyah;
      populateAyahSelector(preservedSura);
      getEl('ayah-select').value = 1;
      updatePageInfo(firstAyah);
      activateAyahInDOM(preservedSura, 1);
      updateNavButtonStates();
    }, 200);
  } else {
    displayPage(1, false);
  }

  if (newRiwaya === 'warsh') showWarshModal();
}

// ─── Selectors ────────────────────────────────────────────────────────────────

function initializeSelectors() {
  populateSurahSelector();
  populateJuzSelector();
  populatePageSelector();
}

function populateSurahSelector() {
  const surahSelect = getEl('surah-select');
  surahSelect.innerHTML = '';
  const surahs = [
    ...new Map(state.quranData.map((item) => [item.sura_no, item])).values(),
  ];
  surahs.forEach((sura) => {
    const option = document.createElement('option');
    option.value = sura.sura_no;
    option.textContent = `${sura.sura_no}. ${sura.sura_name_ar}`;
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

function populateAyahSelector(suraNo) {
  const ayahSelect = getEl('ayah-select');
  ayahSelect.innerHTML = '<option value="">اختر الآية</option>';
  state.quranData
    .filter((item) => item.sura_no == suraNo)
    .forEach((ayah) => {
      const option = document.createElement('option');
      option.value = ayah.aya_no;
      option.textContent = `آية ${ayah.aya_no}`;
      ayahSelect.appendChild(option);
    });
}

function updateSidebarSelectors() {
  if (state.currentAyah) {
    getEl('surah-select').value = state.currentAyah.sura_no;
    getEl('ayah-select').value = state.currentAyah.aya_no;
  }
}

// ─── Page Display ─────────────────────────────────────────────────────────────

function displayPage(pageNum, keepCurrentSura = false) {
  state.currentPage = pageNum;
  saveSetting('currentPage', pageNum);

  const pageData = getAyahsOnPage(pageNum);
  if (pageData.length === 0) return;

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
          !(state.currentRiwaya === 'hafs' && ayah.sura_no === 1) &&
          !(state.currentRiwaya === 'warsh' && ayah.sura_no === 1)
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

// ─── Audio ────────────────────────────────────────────────────────────────────

// ─── Audio Engine (surah MP3 + ayat timing seek) ─────────────────────────────

/**
 * Stop the timeupdate watcher interval.
 */
function stopTimingWatcher() {
  if (state.timingWatcherId !== null) {
    clearInterval(state.timingWatcherId);
    state.timingWatcherId = null;
  }
}

/**
 * Start a polling loop that checks every 50 ms whether the current ayah's
 * end_time has been reached, then calls onAyahEnded().
 * end_time from the API is in milliseconds.
 */
function startTimingWatcher() {
  stopTimingWatcher();
  state.timingWatcherId = setInterval(() => {
    if (!state.audioPlayer || state.audioPlayer.paused) return;
    if (state.currentAyahEndTime === null) return;
    const currentMs = state.audioPlayer.currentTime * 1000;
    if (currentMs >= state.currentAyahEndTime) {
      onAyahEnded();
    }
  }, 50);
}

/**
 * Called when the current ayah's end_time is reached (or the surah file ends).
 * Handles repeat logic and advances the play queue.
 */
function onAyahEnded() {
  stopTimingWatcher();
  state.currentRepeatCount++;

  const repeatControl = getEl('repeat-control').value;
  const maxRepeat =
    repeatControl === 'infinite' ? Infinity : parseInt(repeatControl);

  if (state.currentRepeatCount < maxRepeat) {
    _seekToCurrentQueueAyah();
    return;
  }

  state.currentRepeatCount = 0;
  state.currentPlayIndex++;

  if (state.currentPlayIndex < state.playQueue.length) {
    _playQueueItemAtIndex(state.currentPlayIndex);
  } else {
    state.currentPlayModeRepeatCount++;
    if (state.currentPlayModeRepeatCount < maxRepeat) {
      state.currentPlayIndex = 0;
      state.currentRepeatCount = 0;
      rebuildFullPlayQueue();
      _playQueueItemAtIndex(0);
    } else {
      state.currentPlayModeRepeatCount = 0;
      stopAudio();
    }
  }
}

/**
 * Seek back to the start of the current queue ayah (used for repeat).
 */
function _seekToCurrentQueueAyah() {
  const ayah = state.playQueue[state.currentPlayIndex];
  if (!ayah || !state.currentSurahTiming) return;
  const timing = getAyahTiming(state.currentSurahTiming, ayah.aya_no);
  if (!timing) return;
  state.audioPlayer.currentTime = timing.start_time / 1000;
  state.currentAyahEndTime = timing.end_time;
  startTimingWatcher();
}

/**
 * Core: seek within the loaded surah MP3 to the ayah at queue[index].
 * Loads a new surah file if the surah changes.
 * Fetches timing data on demand (cached after first fetch).
 */
async function _playQueueItemAtIndex(index) {
  if (index >= state.playQueue.length) {
    stopAudio();
    return;
  }

  const ayah = state.playQueue[index];
  state.currentPlayIndex = index;

  // Update UI immediately
  state.currentAyah = ayah;
  state.currentSura = ayah.sura_no;
  saveSetting('currentAyah', ayah.aya_no);
  saveSetting('currentSura', ayah.sura_no);
  updateSidebarSelectors();
  updatePageInfo(ayah);
  highlightActiveAyah();
  updateNavButtonStates();

  // Navigate page if needed
  const ayahElement = document.querySelector(
    `[data-sura="${ayah.sura_no}"][data-ayah="${ayah.aya_no}"]`,
  );
  if (ayahElement) {
    ayahElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    const ayahPage = parseInt(ayah.page.split('-')[0]);
    if (ayahPage !== state.currentPage) {
      displayPage(ayahPage, true);
      setTimeout(() => {
        const el = activateAyahInDOM(ayah.sura_no, ayah.aya_no);
        if (el) updateSidebarSelectors();
      }, 300);
    }
  }

  // Check surah availability for this reciter
  if (!reciterHasSurah(state.selectedReciter, ayah.sura_no)) {
    showToast(
      `القارئ "${state.selectedReciter?.name || ''}" لا يتوفر على سورة رقم ${ayah.sura_no}`,
    );
    stopAudio();
    return;
  }

  // Find matching timing read for this reciter (matched via folder_url == moshaf.server)
  const timingRead = findTimingRead();

  if (!timingRead) {
    // No timing for this reciter — toast once per reciter+surah combo
    const toastKey = `${state.selectedReciter?.id}_${ayah.sura_no}`;
    if (state._noTimingToastKey !== toastKey) {
      state._noTimingToastKey = toastKey;
      showToast(
        `⚠️ القارئ "${state.selectedReciter?.name || ''}" لا يدعم توقيت الآيات — ستُشغَّل السورة كاملة`,
        6000,
      );
    }
    CONSOLE_LOG.playingAyah(
      state.selectedReciter,
      state.currentRiwaya,
      ayah,
      buildSurahAudioUrl(ayah.sura_no),
      null,
    ); // DEBUG — remove with CONSOLE_LOG block
    await _playSurahFromStart(ayah.sura_no);
    return;
  }

  // Fetch timing for this surah (cached)
  const timing = await fetchSurahTiming(timingRead.id, ayah.sura_no);

  if (!timing || timing.length === 0) {
    // Timing exists for this reciter but not this specific surah
    const toastKey = `${state.selectedReciter?.id}_${ayah.sura_no}`;
    if (state._noTimingToastKey !== toastKey) {
      state._noTimingToastKey = toastKey;
      showToast(
        `⚠️ لا يتوفر توقيت آيات لهذه السورة مع هذا القارئ — ستُشغَّل السورة كاملة`,
        6000,
      );
    }
    CONSOLE_LOG.playingAyah(
      state.selectedReciter,
      state.currentRiwaya,
      ayah,
      buildSurahAudioUrl(ayah.sura_no),
      null,
    ); // DEBUG — remove with CONSOLE_LOG block
    await _playSurahFromStart(ayah.sura_no);
    return;
  }

  state.currentSurahTiming = timing;
  const ayahTiming = getAyahTiming(timing, ayah.aya_no);

  if (!ayahTiming) {
    showToast('لم يتم العثور على توقيت هذه الآية');
    stopAudio();
    return;
  }

  state.currentAyahEndTime = ayahTiming.end_time;
  const surahUrl = buildSurahAudioUrl(ayah.sura_no);
  if (!surahUrl) {
    stopAudio();
    return;
  }

  CONSOLE_LOG.playingAyah(
    state.selectedReciter,
    state.currentRiwaya,
    ayah,
    surahUrl,
    ayahTiming,
  ); // DEBUG — remove with CONSOLE_LOG block

  stopTimingWatcher();

  const doSeekAndPlay = () => {
    state.audioPlayer.playbackRate = parseFloat(
      getEl('speed-control')?.value || '1',
    );
    state.audioPlayer.currentTime = ayahTiming.start_time / 1000;
    state.audioPlayer
      .play()
      .then(() => {
        startTimingWatcher();
      })
      .catch((err) => {
        console.error('Playback error:', err);
        state.currentPlayIndex++;
        if (state.currentPlayIndex < state.playQueue.length)
          _playQueueItemAtIndex(state.currentPlayIndex);
      });
  };

  // Same surah already loaded? Just seek, no reload needed
  const isSameSurah =
    state.audioPlayer.src && state.audioPlayer.src === surahUrl;
  if (isSameSurah) {
    doSeekAndPlay();
  } else {
    state.audioPlayer.src = surahUrl;
    state.audioPlayer.load();
    const onCanSeek = () => {
      state.audioPlayer.removeEventListener('canplay', onCanSeek);
      doSeekAndPlay();
    };
    state.audioPlayer.addEventListener('canplay', onCanSeek);
  }
}

/**
 * Fallback: load and play the whole surah file from the beginning.
 * Used when no timing data is available for this reciter.
 */
async function _playSurahFromStart(suraNo) {
  const surahUrl = buildSurahAudioUrl(suraNo);
  if (!surahUrl) {
    stopAudio();
    return;
  }

  state.currentSurahTiming = [];
  state.currentAyahEndTime = null;
  stopTimingWatcher();

  state.audioPlayer.src = surahUrl;
  state.audioPlayer.playbackRate = parseFloat(
    getEl('speed-control')?.value || '1',
  );
  state.audioPlayer.load();

  const onCanPlay = () => {
    state.audioPlayer.removeEventListener('canplay', onCanPlay);
    state.audioPlayer
      .play()
      .catch((err) => console.error('Playback error:', err));
  };
  state.audioPlayer.addEventListener('canplay', onCanPlay);
}

function initializeAudioPlayer() {
  state.audioPlayer = getEl('audio-player');
  if (!state.audioPlayer) return;

  // 'ended' fires when the whole surah file finishes (no-timing fallback or last ayah)
  state.audioPlayer.addEventListener('ended', () => {
    stopTimingWatcher();
    state.currentAyahEndTime = null;

    // In fallback mode (no timing), the whole surah file just played.
    // Skip all remaining ayahs of this surah in the queue so we don't
    // reload and replay the same file for each one.
    if (state.currentSurahTiming.length === 0 && state.playQueue.length > 0) {
      const finishedSura = state.playQueue[state.currentPlayIndex]?.sura_no;
      if (finishedSura != null) {
        while (
          state.currentPlayIndex < state.playQueue.length &&
          state.playQueue[state.currentPlayIndex].sura_no === finishedSura
        ) {
          state.currentPlayIndex++;
        }
        // Step back one — onAyahEnded() will increment it again
        state.currentPlayIndex--;
      }
    }

    onAyahEnded();
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
  const reciterSelect = getEl('reciter-select');
  const selectedId = reciterSelect?.value;

  if (!selectedId) {
    showToast('الرجاء اختيار القارئ');
    return;
  }

  state.selectedReciter =
    state.reciters.find((r) => String(r.id) === selectedId) || null;
  if (!state.selectedReciter) {
    showToast('القارئ غير متوفر');
    return;
  }
  if (!state.currentAyah) {
    showToast('الرجاء اختيار آية');
    return;
  }

  buildPlayQueue();
  if (state.playQueue.length === 0) {
    showToast('لا توجد ملفات صوتية للتشغيل');
    return;
  }

  state.currentPlayIndex = 0;
  state.currentRepeatCount = 0;
  state.currentPlayModeRepeatCount = 0;

  await _playQueueItemAtIndex(0);
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
        state.quranData.filter((i) => i.sura_no === state.currentSura),
      );
      break;
    case 'juz':
      state.playQueue = sliceFromCurrent(
        state.quranData.filter((i) => i.jozz === state.currentJuz),
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
        (i) => i.sura_no === state.currentSura,
      );
      break;
    case 'juz':
      state.playQueue = state.quranData.filter(
        (i) => i.jozz === state.currentJuz,
      );
      break;
  }
}

// Thin wrapper kept for compatibility
function playNextInQueue() {
  _playQueueItemAtIndex(state.currentPlayIndex);
}

function highlightActiveAyah() {
  if (state.currentAyah)
    activateAyahInDOM(state.currentAyah.sura_no, state.currentAyah.aya_no);
}

function jumpToFirstAyahOfPage(pageNum, shouldPlay = false) {
  const pageData = getAyahsOnPage(pageNum);
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
  stopTimingWatcher();
  if (state.audioPlayer) {
    state.audioPlayer.pause();
    state.audioPlayer.src = '';
  }
  state.isPlaying = false;
  state.playQueue = [];
  state.currentPlayIndex = 0;
  state.currentRepeatCount = 0;
  state.currentPlayModeRepeatCount = 0;
  state.currentAyahEndTime = null;
  state.currentSurahTiming = [];
  updatePauseButton();
  syncBottomPlayIcon();
}

function stopAudio() {
  stopTimingWatcher();
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
  state.currentAyahEndTime = null;
  state.currentSurahTiming = [];
  state._noTimingToastKey = null;
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
    // Resume: restart timing watcher if we have active timing
    state.audioPlayer.play().catch(() => {
      if (state.currentAyah) playAudio();
    });
    if (state.currentAyahEndTime !== null) startTimingWatcher();
  } else {
    stopTimingWatcher();
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

/**
 * Change reciter during active/paused playback.
 * Restarts playback from the current ayah's start_time using the new reciter's server.
 */
async function changeReciterDuringPlayback(newReciterId) {
  if (!state.currentAyah || !state.audioPlayer) return;
  const isActivelyPlaying = !state.audioPlayer.paused;
  const isPaused = state.audioPlayer.paused && hasActiveAudioSrc();
  if (!isActivelyPlaying && !isPaused) return;

  state.selectedReciter =
    state.reciters.find((r) => String(r.id) === newReciterId) || null;
  if (!state.selectedReciter) return;

  const ayah = state.playQueue[state.currentPlayIndex] ?? state.currentAyah;

  if (!reciterHasSurah(state.selectedReciter, ayah.sura_no)) {
    showToast(`القارئ "${state.selectedReciter.name}" لا يتوفر على هذه السورة`);
    stopAudio();
    return;
  }

  // Rebuild queue index to point at correct ayah, then replay from current ayah
  if (isActivelyPlaying || isPaused) {
    stopAudio();
    state.currentAyah = ayah;
    state.currentSura = ayah.sura_no;
    buildPlayQueue();
    // Find this ayah's position in the new queue
    const idx = state.playQueue.findIndex(
      (a) => a.sura_no === ayah.sura_no && a.aya_no === ayah.aya_no,
    );
    state.currentPlayIndex = idx >= 0 ? idx : 0;
    if (isActivelyPlaying) await _playQueueItemAtIndex(state.currentPlayIndex);
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

function navigateToAyah(ayahData) {
  const targetPage = parseInt(ayahData.page.split('-')[0]);
  const wasPlaying = state.isPlaying;
  const wasPaused = !wasPlaying && hasActiveAudioSrc();

  if (wasPlaying) stopAudio();
  else if (wasPaused) clearAudioForNavigation();

  if (targetPage !== state.currentPage) {
    displayPage(targetPage, true);
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
    riwayaSelect.addEventListener('change', (e) => {
      switchRiwaya(e.target.value);
    });
  }

  getEl('surah-select').addEventListener('change', (e) => {
    if (state.isSwitchingRiwaya) return;
    const suraNo = parseInt(e.target.value);
    state.currentSura = suraNo;
    const firstAyah = state.quranData.find(
      (item) => item.sura_no === suraNo && item.aya_no === 1,
    );
    if (!firstAyah) return;
    const pageNum = parseInt(firstAyah.page.split('-')[0]);
    displayPage(pageNum, true);
    getEl('surah-select').value = suraNo;
    populateAyahSelector(suraNo);
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

  getEl('juz-select').addEventListener('change', (e) => {
    if (state.isSwitchingRiwaya) return;
    const juzNo = parseInt(e.target.value);
    state.currentJuz = juzNo;
    saveSetting('currentJuz', juzNo);
    const firstAyah = state.quranData.find((item) => item.jozz === juzNo);
    if (firstAyah) {
      const pageNum = parseInt(firstAyah.page.split('-')[0]);
      const wasPlaying = state.isPlaying;
      displayPage(pageNum);
      jumpToFirstAyahOfPage(pageNum, wasPlaying);
    }
  });

  getEl('page-select').addEventListener('change', (e) => {
    if (state.isSwitchingRiwaya) return;
    const pageNum = parseInt(e.target.value);
    const wasPlaying = state.isPlaying;
    displayPage(pageNum);
    jumpToFirstAyahOfPage(pageNum, wasPlaying);
  });

  getEl('ayah-select').addEventListener('change', (e) => {
    const ayahNo = parseInt(e.target.value);
    if (!ayahNo) return;
    const ayahData = state.quranData.find(
      (item) => item.sura_no === state.currentSura && item.aya_no === ayahNo,
    );
    if (!ayahData) return;
    const wasPlaying = state.isPlaying;
    const wasPaused = !wasPlaying && hasActiveAudioSrc();
    const ayahPage = parseInt(ayahData.page.split('-')[0]);
    if (ayahPage !== state.currentPage) {
      displayPage(ayahPage, true);
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

  getEl('reciter-select').addEventListener('change', (e) => {
    const newId = e.target.value;
    state.selectedReciter =
      state.reciters.find((r) => String(r.id) === newId) || null;
    state._noTimingToastKey = null;
    saveSetting('reciter', newId);
    changeReciterDuringPlayback(newId);
  });

  getEl('speed-control').addEventListener('change', (e) => {
    const speed = e.target.value;
    if (state.audioPlayer) state.audioPlayer.playbackRate = parseFloat(speed);
    saveSetting('speed', speed);
  });

  getEl('repeat-control').addEventListener('change', (e) => {
    saveSetting('repeat', e.target.value);
  });
  getEl('play-mode').addEventListener('change', (e) => {
    saveSetting('playMode', e.target.value);
  });

  getEl('font-size-control').addEventListener('change', (e) => {
    applyFontSize(e.target.value);
    saveSetting('fontSize', e.target.value);
  });

  getEl('prev-page').addEventListener('click', () => {
    if (state.currentPage > 1) {
      const newPage = state.currentPage - 1;
      const wasPlaying = state.isPlaying;
      displayPage(newPage);
      jumpToFirstAyahOfPage(newPage, wasPlaying);
    }
  });

  getEl('next-page').addEventListener('click', () => {
    if (state.currentPage < TOTAL_PAGES) {
      const newPage = state.currentPage + 1;
      const wasPlaying = state.isPlaying;
      displayPage(newPage);
      jumpToFirstAyahOfPage(newPage, wasPlaying);
    }
  });

  getEl('play-btn').addEventListener('click', playAudio);
  getEl('pause-btn').addEventListener('click', togglePauseResume);
  getEl('stop-btn').addEventListener('click', stopAudio);

  document.addEventListener('keydown', (e) => {
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
        const nextAyah = state.quranData.find(
          (item) =>
            item.sura_no === state.currentAyah.sura_no &&
            item.aya_no === state.currentAyah.aya_no + 1,
        );
        if (nextAyah) navigateToAyah(nextAyah);
        else {
          const n = state.quranData.find(
            (item) =>
              item.sura_no === state.currentAyah.sura_no + 1 &&
              item.aya_no === 1,
          );
          if (n) navigateToAyah(n);
        }
      }
      return;
    }

    if (e.code === 'ArrowRight') {
      e.preventDefault();
      if (state.currentAyah) {
        const prevAyah = state.quranData.find(
          (item) =>
            item.sura_no === state.currentAyah.sura_no &&
            item.aya_no === state.currentAyah.aya_no - 1,
        );
        if (prevAyah) navigateToAyah(prevAyah);
        else if (state.currentAyah.sura_no > 1) {
          const prevSuraAyahs = state.quranData.filter(
            (item) => item.sura_no === state.currentAyah.sura_no - 1,
          );
          if (prevSuraAyahs.length)
            navigateToAyah(prevSuraAyahs[prevSuraAyahs.length - 1]);
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
    const offcanvasEl = document.getElementById('offcanvasSidebar');
    const bsOffcanvas = bootstrap.Offcanvas.getOrCreateInstance(offcanvasEl);
    bsOffcanvas.show();
  });
document.getElementById('fab-about-btn').addEventListener('click', function () {
  closeFab();
  const aboutEl = document.getElementById('aboutModal');
  const bsModal = bootstrap.Modal.getOrCreateInstance(aboutEl);
  bsModal.show();
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

  const hasPrevAyah = !!state.quranData.find(
    (i) => i.sura_no === sura && i.aya_no === aya - 1,
  );
  const hasPrevSurah = sura > 1;
  const hasNextAyah =
    !!state.quranData.find((i) => i.sura_no === sura && i.aya_no === aya + 1) ||
    sura < 114;
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
  const next = state.quranData.find(
    (i) =>
      i.sura_no === state.currentAyah.sura_no &&
      i.aya_no === state.currentAyah.aya_no + 1,
  );
  if (next) {
    navigateToAyah(next);
    return;
  }
  const nextSura = state.quranData.find(
    (i) => i.sura_no === state.currentAyah.sura_no + 1 && i.aya_no === 1,
  );
  if (nextSura) navigateToAyah(nextSura);
}

function bottomNavPrev() {
  if (!state.currentAyah) return;
  const prev = state.quranData.find(
    (i) =>
      i.sura_no === state.currentAyah.sura_no &&
      i.aya_no === state.currentAyah.aya_no - 1,
  );
  if (prev) {
    navigateToAyah(prev);
    return;
  }
  if (state.currentAyah.sura_no > 1) {
    const prevSuraAyahs = state.quranData.filter(
      (i) => i.sura_no === state.currentAyah.sura_no - 1,
    );
    if (prevSuraAyahs.length)
      navigateToAyah(prevSuraAyahs[prevSuraAyahs.length - 1]);
  }
}

function bottomNavPrevSurah() {
  if (!state.currentAyah || state.currentAyah.sura_no <= 1) return;
  const firstAyah = state.quranData.find(
    (i) => i.sura_no === state.currentAyah.sura_no - 1 && i.aya_no === 1,
  );
  if (firstAyah) navigateToAyah(firstAyah);
}

function bottomNavNextSurah() {
  if (!state.currentAyah || state.currentAyah.sura_no >= 114) return;
  const firstAyah = state.quranData.find(
    (i) => i.sura_no === state.currentAyah.sura_no + 1 && i.aya_no === 1,
  );
  if (firstAyah) navigateToAyah(firstAyah);
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
  const lbl = document.getElementById('warshTimerLabel');
  const cnt = document.getElementById('warshCountdown');

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
