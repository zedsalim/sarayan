// ─── Constants ────────────────────────────────────────────────────────────────
const TOTAL_PAGES = 604;
const SURAH_NO_BASMALA = 9; // Surah At-Tawbah has no Basmala
const WARSH_MODAL_KEY = 'warshModalSeen';
const WARSH_TIMER_MS = 5000;

/**
 * Riwaya configuration.
 * Each entry defines:
 *   - textFile   : path to the JSON data file for that riwaya's text
 *   - audioDir   : subfolder inside assets/audio/ for offline files
 *   - audioUrls  : array of fallback URL JSON file paths (online streaming)
 *   - font       : CSS font-family name to apply when this riwaya is active
 *   - reciters   : map of reciter value → Arabic display name
 */
const RIWAYA_CONFIG = {
  warsh: {
    textFile: 'assets/text/UthmanicWarsh/warshData_v2-1.json',
    audioDir: 'warsh',
    audioUrls: [
      'assets/audio/quran_audio_urls-1_warsh.json',
      'assets/audio/quran_audio_urls-2_warsh.json',
      'assets/audio/quran_audio_urls-3_warsh.json',
      'assets/audio/quran_audio_urls-4_warsh.json',
      'assets/audio/quran_audio_urls-5_warsh.json',
    ],
    font: 'Uthmanic',
    reciters: {
      abdelbasset_abdessamad: 'عبد الباسط عبد الصمد',
    },
  },
  hafs: {
    textFile: 'assets/text/UthmanicHafs/hafsData_v2-0.json',
    audioDir: 'hafs',
    audioUrls: [
      'assets/audio/quran_audio_urls-1_hafs.json',
      'assets/audio/quran_audio_urls-2_hafs.json',
      'assets/audio/quran_audio_urls-3_hafs.json',
      'assets/audio/quran_audio_urls-4_hafs.json',
    ],
    font: 'UthmanicHafs',
    reciters: {
      abdelbasset_abdessamad: 'عبد الباسط عبد الصمد',
    },
  },
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  quranData: [],
  audioUrlsSources: [],
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

/** Safe getElementById shorthand */
function getEl(id) {
  return document.getElementById(id);
}

/** Save a key-value pair to localStorage */
function saveSetting(key, value) {
  localStorage.setItem(key, value);
}

/** Apply font size to the Quran text container */
function applyFontSize(size) {
  getEl('quran-text').style.fontSize = size + 'px';
}

/**
 * Filter quranData for ayahs that appear on a given page number.
 * Centralises the repeated page-split/filter pattern.
 */
function getAyahsOnPage(pageNum) {
  return state.quranData.filter((item) => {
    const pages = item.page.split('-');
    return pages.some((p) => parseInt(p.trim()) === pageNum);
  });
}

/**
 * Remove the active highlight from all ayah elements, then optionally
 * highlight and scroll to a specific element.
 */
function setActiveAyahElement(element) {
  document
    .querySelectorAll('.ayah.active')
    .forEach((el) => el.classList.remove('active'));

  if (element) {
    element.classList.add('active');
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Find the rendered DOM element for a given sura/ayah pair and activate it.
 * Returns the element if found, null otherwise.
 */
function activateAyahInDOM(suraNo, ayahNo) {
  const el = document.querySelector(
    `[data-sura="${suraNo}"][data-ayah="${ayahNo}"]`,
  );
  setActiveAyahElement(el);
  return el;
}

/** Build the audio file path for a given reciter and ayah */
function buildAudioPath(reciter, suraNo, ayahNo) {
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  const audioDir = cfg ? cfg.audioDir : state.currentRiwaya;
  return `assets/audio/${audioDir}/${reciter}/${String(suraNo).padStart(3, '0')}/${String(ayahNo).padStart(3, '0')}.mp3`;
}

/**
 * Look up a fallback online URL from the loaded JSON sources for a given reciter/sura/ayah.
 * Randomly selects from available sources each call to distribute bandwidth
 * across all hosted accounts and avoid hitting any single Cloudinary quota.
 */
function getFallbackAudioUrl(reciter, suraNo, ayahNo) {
  const sources = state.audioUrlsSources;
  if (!sources || sources.length === 0) return null;

  const suraKey = String(suraNo).padStart(3, '0');
  const ayahKey = String(ayahNo).padStart(3, '0');

  // Shuffle source indices so load is distributed randomly across accounts
  const order = [...sources.keys()].sort(() => Math.random() - 0.5);

  for (const idx of order) {
    const source = sources[idx];
    const reciters = source?.reciters;
    if (!reciters) continue;
    const reciterData = reciters[reciter];
    if (!reciterData) continue;
    const ayahs = reciterData[suraKey];
    if (!ayahs) continue;
    const found = ayahs.find((a) => a.ayah === ayahKey);
    if (found?.url) return found.url;
  }

  return null;
}

/**
 * Check once (per reciter+surah) whether local audio files exist.
 * Uses a HEAD request on ayah 001 of the surah as a proxy for the whole surah.
 * Result is cached so subsequent calls are instant.
 */
async function checkLocalAudioAvailable(reciter, suraNo) {
  const cacheKey = `${reciter}/${suraNo}`;
  if (cacheKey in state.localAudioCache) {
    return state.localAudioCache[cacheKey];
  }
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
  // Load riwaya preference before fetching any data
  const savedRiwaya = localStorage.getItem('riwaya') || 'warsh';
  state.currentRiwaya = savedRiwaya;
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) riwayaSelect.value = savedRiwaya;

  await loadQuranData();
  await loadAudioUrlsData();
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

/** Restore the previously selected ayah after the page has been rendered */
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

/** Load persisted user settings from localStorage */
function loadSettings() {
  // Reciter is populated separately in populateReciterOptions()
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
    const textFile = cfg
      ? cfg.textFile
      : 'assets/text/UthmanicWarsh/warshData_v2-1.json';
    const response = await fetch(textFile);
    const raw = await response.json();
    state.quranData = raw.map((item) => ({
      ...item,
      page: String(item.page),
    }));
  } catch (error) {
    console.error('Error loading Quran data:', error);
    showToast('خطأ في تحميل بيانات القرآن الكريم');
  }
}

async function loadAudioUrlsData() {
  const files = RIWAYA_CONFIG[state.currentRiwaya].audioUrls;

  const results = await Promise.allSettled(
    files.map((f) => fetch(f).then((r) => r.json())),
  );

  state.audioUrlsSources = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  if (state.audioUrlsSources.length === 0) {
    console.warn('Could not load any audio URLs fallback data.');
  } else {
    console.log(
      `Loaded ${state.audioUrlsSources.length} audio URL source(s) for load balancing.`,
    );
  }
}

/** Cycle through available riwayas when the badge is clicked */
function cycleRiwaya() {
  const riwayas = Object.keys(RIWAYA_CONFIG);
  const currentIdx = riwayas.indexOf(state.currentRiwaya);
  const nextRiwaya = riwayas[(currentIdx + 1) % riwayas.length];

  // Sync the sidebar select then trigger the switch
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) riwayaSelect.value = nextRiwaya;
  switchRiwaya(nextRiwaya);
}

/** Apply the Quran text font for the currently-active riwaya */
function applyRiwayaFont() {
  const cfg = RIWAYA_CONFIG[state.currentRiwaya];
  if (!cfg) return;
  const quranTextEl = getEl('quran-text');
  if (quranTextEl) quranTextEl.style.fontFamily = `'${cfg.font}', serif`;

  // Update header badge
  const badge = getEl('riwaya-badge');
  if (badge) {
    badge.textContent = state.currentRiwaya === 'hafs' ? 'حفص' : 'ورش';
  }
}

/** Populate the reciter <select> with options valid for the current riwaya */
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

  // Restore saved reciter if it is valid for this riwaya, else pick first
  const saved = localStorage.getItem('reciter') || '';
  reciterSelect.value = cfg.reciters[saved]
    ? saved
    : Object.keys(cfg.reciters)[0];
  state.selectedReciter = reciterSelect.value;
}

/**
 * Switch riwaya: stop audio, reload text data and audio URLs,
 * re-render the current page, and update UI.
 */
async function switchRiwaya(newRiwaya) {
  if (newRiwaya === state.currentRiwaya) return;

  // Remember which surah the user was on
  const preservedSura = state.currentSura || 1;

  stopAudio();
  state.currentRiwaya = newRiwaya;
  saveSetting('riwaya', newRiwaya);

  // Clear caches that were built for the previous riwaya
  state.localAudioCache = {};
  state.audioUrlsSources = [];

  showToast('تحويل الرواية...');

  await loadQuranData();
  await loadAudioUrlsData();

  applyRiwayaFont();
  populateReciterOptions();

  // Re-build selectors with new data — flag suppresses spurious change events
  state.isSwitchingRiwaya = true;
  populateSurahSelector();
  populateJuzSelector();
  populatePageSelector();
  state.isSwitchingRiwaya = false;

  // Reset state then navigate to the preserved surah
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

  if (newRiwaya === 'warsh') {
    showWarshModal();
  }
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

/** Sync sidebar dropdowns to match the current ayah */
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

  // Track which surah headers we've already rendered
  const displayedSuraHeaders = new Set();
  let previousSuraNo = null;

  // Pre-compute which surahs begin on this page (determines whether to show Basmala)
  const surahsStartingOnPage = new Set(
    pageData.filter((a) => a.aya_no === 1).map((a) => a.sura_no),
  );

  pageData.forEach((ayah, index) => {
    // Insert surah header + optional Basmala when we encounter a new surah
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
    ayahSpan.textContent = ayah.aya_text + ' ';
    ayahSpan.addEventListener('click', (e) =>
      handleAyahClickWithToggle(e, ayah),
    );
    quranTextDiv.appendChild(ayahSpan);
  });

  // Update header with surah info
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

  // Always sync juz
  state.currentJuz = pageData[0].jozz;
  getEl('juz-select').value = state.currentJuz;
  saveSetting('currentJuz', state.currentJuz);

  populateAyahSelector(state.currentSura);

  getEl('prev-page').disabled = state.currentPage === 1;
  getEl('next-page').disabled = state.currentPage === TOTAL_PAGES;
}

/** Update the page header with surah name and juz/page numbers */
function updatePageInfo(pageData) {
  getEl('sura-title').textContent = pageData.sura_name_ar;
  getEl('page-info').textContent =
    `الجزء ${pageData.jozz} - صفحة ${state.currentPage}`;
}

// ─── Ayah Selection ───────────────────────────────────────────────────────────

/**
 * Set the current ayah, sync all UI selectors, persist to storage,
 * and optionally trigger playback.
 */
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

/** Select an ayah and immediately start playback */
function selectAndPlayAyah(ayahData) {
  if (state.isPlaying) stopAudio();
  setCurrentAyah(ayahData, { play: true });
}

/** Handle a click on a rendered ayah span — toggle play/pause or start new */
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

/** Navigate to and highlight the first ayah of a surah without triggering playback */
function selectFirstAyahOfSurah(suraNo) {
  const firstAyah = state.quranData.find(
    (item) => item.sura_no === suraNo && item.aya_no === 1,
  );

  if (!firstAyah) return;

  state.currentAyah = firstAyah;
  state.currentSura = suraNo;
  getEl('ayah-select').value = 1;
  updatePageInfo(firstAyah);
  saveSetting('currentAyah', 1);

  setTimeout(() => activateAyahInDOM(suraNo, 1), 100);
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

  // Check once whether local audio exists for this reciter+surah
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

/**
 * Rebuild the full play queue from the very beginning of the play mode
 * (used when repeating the whole queue after it finishes).
 */
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

function playNextInQueue() {
  if (state.currentPlayIndex >= state.playQueue.length) {
    stopAudio();
    return;
  }

  const ayah = state.playQueue[state.currentPlayIndex];
  state.selectedReciter = getEl('reciter-select')?.value || '';

  // When crossing into a new surah during queue playback, re-check local availability
  const cacheKey = `${state.selectedReciter}/${ayah.sura_no}`;
  if (!(cacheKey in state.localAudioCache)) {
    // Async re-check for new surah; temporarily assume same strategy
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
    audioSrc =
      getFallbackAudioUrl(state.selectedReciter, ayah.sura_no, ayah.aya_no) ||
      buildAudioPath(state.selectedReciter, ayah.sura_no, ayah.aya_no);
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

  // If the ayah is not on the current page, navigate to it
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
}

/** Re-apply the active highlight to whichever ayah is current */
function highlightActiveAyah() {
  if (state.currentAyah) {
    activateAyahInDOM(state.currentAyah.sura_no, state.currentAyah.aya_no);
  }
}

/**
 * Jump to the first ayah of a page and start playback from there.
 * Used when navigating pages while audio is active.
 */
function jumpToFirstAyahOfPage(pageNum, shouldPlay = false) {
  const pageData = getAyahsOnPage(pageNum);
  if (pageData.length === 0) return;

  const firstAyah = pageData[0];

  // Stop current playback cleanly
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

/** Update the pause/resume button label to reflect current playback state */
function updatePauseButton() {
  const pauseBtn = getEl('pause-btn');
  const isPaused = state.audioPlayer?.paused ?? true;

  const html =
    isPaused || !state.isPlaying
      ? '<i class="bi bi-play-fill"></i> استئناف'
      : '<i class="bi bi-pause-fill"></i> إيقاف مؤقت';

  if (pauseBtn) pauseBtn.innerHTML = html;
}

/** Switch the reciter while audio is actively playing */
async function changeReciterDuringPlayback(newReciter) {
  if (!state.isPlaying || !state.currentAyah || !state.audioPlayer) return;

  if (!state.audioPlayer.paused) {
    const currentPlayingAyah = state.playQueue[state.currentPlayIndex];
    const useLocal = await checkLocalAudioAvailable(
      newReciter,
      currentPlayingAyah.sura_no,
    );
    state.useLocalAudio = useLocal;

    const audioSrc = useLocal
      ? buildAudioPath(
          newReciter,
          currentPlayingAyah.sura_no,
          currentPlayingAyah.aya_no,
        )
      : getFallbackAudioUrl(
          newReciter,
          currentPlayingAyah.sura_no,
          currentPlayingAyah.aya_no,
        ) ||
        buildAudioPath(
          newReciter,
          currentPlayingAyah.sura_no,
          currentPlayingAyah.aya_no,
        );

    state.audioPlayer.src = audioSrc;
    state.audioPlayer.playbackRate = parseFloat(
      getEl('speed-control')?.value || '1',
    );
    state.audioPlayer.play().catch((error) => {
      console.error('Error playing audio with new reciter:', error);
    });
  }
}

/** Step playback speed up (+1) or down (-1) through the available speed options */
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

  if (newIndex === currentIndex) return; // already at min/max

  const newSpeed = options[newIndex];
  speedSelect.value = String(newSpeed);
  if (state.audioPlayer) state.audioPlayer.playbackRate = newSpeed;
  saveSetting('speed', String(newSpeed));

  // Brief visual feedback on the speed selector
  speedSelect.style.transition = 'background-color 0.2s';
  speedSelect.style.backgroundColor = '#c8a96e44';
  setTimeout(() => (speedSelect.style.backgroundColor = ''), 400);

  syncBottomSpeedLabel();
}

/**
 * Navigate to an ayah: switch page if needed, update selectors,
 * highlight the ayah, and resume playback if audio was active.
 */
function navigateToAyah(ayahData) {
  const targetPage = parseInt(ayahData.page.split('-')[0]);
  const wasPlaying = state.isPlaying;

  if (wasPlaying) stopAudio();

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
  // Riwaya selector
  const riwayaSelect = getEl('riwaya-select');
  if (riwayaSelect) {
    riwayaSelect.addEventListener('change', (e) => {
      switchRiwaya(e.target.value);
    });
  }

  // Surah selector
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
    if (wasPlaying) stopAudio();

    setTimeout(() => {
      activateAyahInDOM(suraNo, 1);
      getEl('ayah-select').value = 1;
      updatePageInfo(firstAyah);

      if (wasPlaying && getEl('reciter-select').value) playAudio();
    }, 100);
  });

  // Juz selector
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

  // Page selector
  getEl('page-select').addEventListener('change', (e) => {
    if (state.isSwitchingRiwaya) return;
    const pageNum = parseInt(e.target.value);
    const wasPlaying = state.isPlaying;
    displayPage(pageNum);
    jumpToFirstAyahOfPage(pageNum, wasPlaying);
  });

  // Ayah selector
  getEl('ayah-select').addEventListener('change', (e) => {
    const ayahNo = parseInt(e.target.value);
    if (!ayahNo) return;

    const ayahData = state.quranData.find(
      (item) => item.sura_no === state.currentSura && item.aya_no === ayahNo,
    );

    if (!ayahData) return;

    const wasPlaying = state.isPlaying;
    const ayahPage = parseInt(ayahData.page.split('-')[0]);
    if (ayahPage !== state.currentPage) {
      displayPage(ayahPage, true);
      setTimeout(() => {
        if (wasPlaying) {
          selectAndPlayAyah(ayahData);
        } else {
          setCurrentAyah(ayahData);
        }
      }, 200);
    } else {
      if (wasPlaying) {
        selectAndPlayAyah(ayahData);
      } else {
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
  getEl('repeat-control').addEventListener('change', (e) => {
    saveSetting('repeat', e.target.value);
  });

  // Play mode
  getEl('play-mode').addEventListener('change', (e) => {
    saveSetting('playMode', e.target.value);
  });

  // Font size control
  getEl('font-size-control').addEventListener('change', (e) => {
    applyFontSize(e.target.value);
    saveSetting('fontSize', e.target.value);
  });

  // Page navigation buttons
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

  // Playback control buttons
  getEl('play-btn').addEventListener('click', playAudio);
  getEl('pause-btn').addEventListener('click', togglePauseResume);
  getEl('stop-btn').addEventListener('click', stopAudio);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Skip when the user is typing in a form element
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    // Space → play / pause
    if (e.code === 'Space') {
      e.preventDefault();
      const hasAudio = state.audioPlayer?.src && state.audioPlayer.src !== '';
      if (hasAudio) {
        togglePauseResume();
      } else if (state.currentAyah) {
        playAudio();
      }
      return;
    }

    // Number keys 0-9 → seek to that tenth of the audio (0 = 0%, 9 = 90%)
    const numMatch = e.code.match(/^(?:Digit|Numpad)([0-9])$/);
    if (
      numMatch &&
      state.audioPlayer?.src &&
      state.audioPlayer.src !== '' &&
      state.audioPlayer.duration
    ) {
      e.preventDefault();
      const percent = parseInt(numMatch[1]) / 10;
      state.audioPlayer.currentTime = state.audioPlayer.duration * percent;
      return;
    }

    // Arrow Left → next ayah (or first ayah of next surah if at end)
    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      if (state.currentAyah) {
        const nextAyah = state.quranData.find(
          (item) =>
            item.sura_no === state.currentAyah.sura_no &&
            item.aya_no === state.currentAyah.aya_no + 1,
        );
        if (nextAyah) {
          navigateToAyah(nextAyah);
        } else {
          // End of surah — try first ayah of next surah
          const nextSurahFirstAyah = state.quranData.find(
            (item) =>
              item.sura_no === state.currentAyah.sura_no + 1 &&
              item.aya_no === 1,
          );
          if (nextSurahFirstAyah) navigateToAyah(nextSurahFirstAyah);
        }
      }
      return;
    }

    // Arrow Right → prev ayah (or last ayah of prev surah if at start)
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      if (state.currentAyah) {
        const prevAyah = state.quranData.find(
          (item) =>
            item.sura_no === state.currentAyah.sura_no &&
            item.aya_no === state.currentAyah.aya_no - 1,
        );
        if (prevAyah) {
          navigateToAyah(prevAyah);
        } else if (state.currentAyah.sura_no > 1) {
          // Start of surah — go to last ayah of previous surah
          const prevSuraAyahs = state.quranData.filter(
            (item) => item.sura_no === state.currentAyah.sura_no - 1,
          );
          if (prevSuraAyahs.length > 0) {
            navigateToAyah(prevSuraAyahs[prevSuraAyahs.length - 1]);
          }
        }
      }
      return;
    }

    // + / = → increase playback speed
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault();
      changeSpeed(1);
      return;
    }

    // - → decrease playback speed
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      changeSpeed(-1);
      return;
    }
  });
}

// ─── Bottom Controls Bar ──────────────────────────────────────────────────────

/** Keep the bottom speed label in sync with the sidebar speed selector */
function syncBottomSpeedLabel() {
  const sel = getEl('speed-control');
  const label = getEl('bottom-speed-label');
  if (sel && label) label.textContent = parseFloat(sel.value) + 'x';
}

/** Sync the play/pause icon in the bottom bar to match actual playback state */
function syncBottomPlayIcon() {
  const icon = getEl('bottom-play-icon');
  if (!icon) return;
  icon.className = state.isPlaying ? 'bi bi-pause-fill' : 'bi bi-play-fill';
}

/** Update disabled state of bottom nav buttons based on current ayah position */
function updateNavButtonStates() {
  const btns = document.querySelectorAll('.bottom-controls .ctrl-btn');
  // We select by onclick attribute for reliability
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
    if (prevSurahBtn) prevSurahBtn.disabled = true;
    if (prevAyahBtn) prevAyahBtn.disabled = true;
    if (nextAyahBtn) nextAyahBtn.disabled = true;
    if (nextSurahBtn) nextSurahBtn.disabled = true;
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

/** Bottom bar play/pause button handler */
function bottomPlayPause() {
  const hasAudio = state.audioPlayer?.src && state.audioPlayer.src !== '';
  if (hasAudio) {
    togglePauseResume();
  } else if (state.currentAyah) {
    playAudio();
  }
  setTimeout(syncBottomPlayIcon, 100);
}

/** Bottom bar — navigate to next ayah, or first ayah of next surah */
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

/** Bottom bar — navigate to previous ayah, or last ayah of previous surah */
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

/** Bottom bar — navigate to first ayah of previous surah */
function bottomNavPrevSurah() {
  if (!state.currentAyah || state.currentAyah.sura_no <= 1) return;
  const firstAyah = state.quranData.find(
    (i) => i.sura_no === state.currentAyah.sura_no - 1 && i.aya_no === 1,
  );
  if (firstAyah) navigateToAyah(firstAyah);
}

/** Bottom bar — navigate to first ayah of next surah */
function bottomNavNextSurah() {
  if (!state.currentAyah || state.currentAyah.sura_no >= 114) return;
  const firstAyah = state.quranData.find(
    (i) => i.sura_no === state.currentAyah.sura_no + 1 && i.aya_no === 1,
  );
  if (firstAyah) navigateToAyah(firstAyah);
}

/** Wire up bottom bar sync listeners — called once after DOM + settings are ready */
function initializeBottomControls() {
  syncBottomSpeedLabel();

  const player = getEl('audio-player');
  if (player) {
    player.addEventListener('play', () => setTimeout(syncBottomPlayIcon, 50));
    player.addEventListener('pause', () => setTimeout(syncBottomPlayIcon, 50));
    player.addEventListener('ended', () => setTimeout(syncBottomPlayIcon, 50));
  }

  const speedSel = getEl('speed-control');
  if (speedSel) speedSel.addEventListener('change', syncBottomSpeedLabel);
}

// ─── Utilities ──────────────────────────────────────────────────────
/** Fullscreen Toggle */
function toggleFullscreen() {
  document.body.classList.toggle('fullscreen-mode');
}

/**
 * Starts the countdown timer and progress bar inside the modal.
 * Enables the close button when the timer reaches zero.
 */
function startWarshModalTimer() {
  const bar = document.getElementById('warshProgressBar');
  const countdown = document.getElementById('warshCountdown');
  const closeBtn = document.getElementById('warshCloseBtn');
  const label = document.getElementById('warshTimerLabel');

  if (!bar || !closeBtn) return;

  let remaining = WARSH_TIMER_MS / 1000;

  // Shrink the bar over exactly WARSH_TIMER_MS milliseconds
  requestAnimationFrame(() => {
    bar.style.width = '100%';
    requestAnimationFrame(() => {
      bar.style.transition = `width ${WARSH_TIMER_MS}ms linear`;
      bar.style.width = '0%';
    });
  });

  // Decrement the countdown every second
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

/**
 * Shows Warsh Maghribi Text Style Modal
 */
function showWarshModal() {
  if (localStorage.getItem(WARSH_MODAL_KEY) === '1') return;
  if (state.currentRiwaya !== 'warsh') return;

  const modalEl = document.getElementById('warshInfoModal');
  if (!modalEl) return;

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl, {
    backdrop: 'static',
    keyboard: false,
  });

  // Reset the progress bar and button state before showing
  const bar = document.getElementById('warshProgressBar');
  const btn = document.getElementById('warshCloseBtn');
  const lbl = document.getElementById('warshTimerLabel');
  const cnt = document.getElementById('warshCountdown');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '100%';
  }
  if (btn) {
    btn.classList.add('disabled');
  }
  // Persist seen state to localStorage when the modal is closed
  modalEl.addEventListener(
    'hidden.bs.modal',
    () => {
      localStorage.setItem(WARSH_MODAL_KEY, '1');
    },
    { once: true },
  );

  modal.show();

  // Start the timer once the modal is fully visible
  modalEl.addEventListener(
    'shown.bs.modal',
    () => {
      // Re-enable the CSS transition that was removed before showing
      const b = document.getElementById('warshProgressBar');
      if (b) {
        b.style.transition = '';
      }
      startWarshModalTimer();
    },
    { once: true },
  );
}
