// ─── Constants ────────────────────────────────────────────────────────────────
const TOTAL_PAGES = 604;
const SURAH_NO_BASMALA = 9; // Surah At-Tawbah has no Basmala

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  quranData: [],
  audioUrlsData: null,
  localAudioCache: {},
  useLocalAudio: true,
  currentPage: 1,
  currentSura: 1,
  currentJuz: 1,
  currentAyah: null,
  selectedReciter: '',
  audioPlayer: null,
  playQueue: [],
  currentPlayIndex: 0,
  repeatCount: 1,
  currentRepeatCount: 0,
  isPlaying: false,
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
  return `assets/audio/${reciter}/${String(suraNo).padStart(3, '0')}/${String(ayahNo).padStart(3, '0')}.mp3`;
}

/** Look up a fallback online URL from the loaded JSON for a given reciter/sura/ayah */
function getFallbackAudioUrl(reciter, suraNo, ayahNo) {
  if (!state.audioUrlsData) return null;
  const reciters = state.audioUrlsData.reciters;
  if (!reciters) return null;
  const reciterData = reciters[reciter];
  if (!reciterData) return null;
  const suraKey = String(suraNo).padStart(3, '0');
  const ayahKey = String(ayahNo).padStart(3, '0');
  const ayahs = reciterData[suraKey];
  if (!ayahs) return null;
  const found = ayahs.find((a) => a.ayah === ayahKey);
  return found ? found.url : null;
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
  // Reuse an existing toast container or create one
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText =
    'background:#5d4037;color:#fff;padding:12px 24px;border-radius:8px;font-family:Amiri,Arial,sans-serif;font-size:16px;box-shadow:0 4px 12px rgba(0,0,0,0.25);opacity:0;transition:opacity 0.3s;';
  container.appendChild(toast);

  // Fade in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
    });
  });

  // Fade out and remove after 3 s
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadQuranData();
  await loadAudioUrlsData();
  initializeSelectors();
  initializeAudioPlayer();
  loadSettings();
  initializeEventListeners();

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
}

/** Load persisted user settings from localStorage */
function loadSettings() {
  const savedReciter =
    localStorage.getItem('reciter') || 'abdelbasset_abdessamad';
  getEl('reciter-select').value = savedReciter;

  const savedSpeed = localStorage.getItem('speed') || '1';
  getEl('speed-control').value = savedSpeed;

  const savedRepeat = localStorage.getItem('repeat') || '1';
  getEl('repeat-control').value = savedRepeat;

  const savedPlayMode = localStorage.getItem('playMode') || 'sura';
  getEl('play-mode').value = savedPlayMode;

  const savedFontSize = localStorage.getItem('fontSize') || '28';
  getEl('font-size-control').value = savedFontSize;
  applyFontSize(savedFontSize);
}

// ─── Data Loading ─────────────────────────────────────────────────────────────

async function loadQuranData() {
  try {
    const response = await fetch(
      'assets/text/UthmanicWarsh/warshData_v2-1.json',
    );
    state.quranData = await response.json();
  } catch (error) {
    console.error('Error loading Quran data:', error);
    showToast('خطأ في تحميل بيانات القرآن الكريم');
  }
}

async function loadAudioUrlsData() {
  try {
    const response = await fetch('assets/text/quran_audio_urls.json');
    state.audioUrlsData = await response.json();
  } catch (error) {
    console.warn('Could not load audio URLs fallback data:', error);
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
          ayah.sura_no !== SURAH_NO_BASMALA
        ) {
          const basmalaDiv = document.createElement('div');
          basmalaDiv.className = 'basmala';
          basmalaDiv.textContent = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';
          quranTextDiv.appendChild(basmalaDiv);
        }
      }
    }

    if (index > 0 && ayah.line_start > pageData[index - 1].line_end) {
      quranTextDiv.appendChild(document.createElement('br'));
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

  const hasAudioLoaded =
    state.audioPlayer &&
    state.audioPlayer.readyState > 0 &&
    state.isPlaying !== false;

  if (isSameAyah && hasAudioLoaded) {
    togglePauseResume();
  } else {
    setCurrentAyah(ayah);
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
        stopAudio();
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
function jumpToFirstAyahOfPage(pageNum) {
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
    if (getEl('reciter-select').value) playAudio();
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
  state.playQueue = [];

  updatePauseButton();
}

function togglePauseResume() {
  if (!state.audioPlayer) return;

  // Don't attempt to play if no source is actually loaded
  if (state.audioPlayer.paused && state.audioPlayer.readyState === 0) {
    if (state.currentAyah) playAudio();
    return;
  }

  if (state.audioPlayer.paused) {
    state.audioPlayer.play();
  } else {
    state.audioPlayer.pause();
  }
}

/** Update the pause/resume button label to reflect current playback state */
function updatePauseButton() {
  const pauseBtn = getEl('pause-btn');
  const isPaused = state.audioPlayer?.paused ?? true;
  const text = isPaused || !state.isPlaying ? '▶ استئناف' : '⏸ إيقاف مؤقت';
  if (pauseBtn) pauseBtn.textContent = text;
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
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function initializeEventListeners() {
  // Surah selector
  getEl('surah-select').addEventListener('change', (e) => {
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

    setTimeout(() => {
      activateAyahInDOM(suraNo, 1);
      getEl('ayah-select').value = 1;
      updatePageInfo(firstAyah);

      if (getEl('reciter-select').value) playAudio();
    }, 100);
  });

  // Juz selector
  getEl('juz-select').addEventListener('change', (e) => {
    const juzNo = parseInt(e.target.value);
    state.currentJuz = juzNo;
    saveSetting('currentJuz', juzNo);

    const firstAyah = state.quranData.find((item) => item.jozz === juzNo);
    if (firstAyah) {
      const pageNum = parseInt(firstAyah.page.split('-')[0]);
      displayPage(pageNum);
      jumpToFirstAyahOfPage(pageNum);
    }
  });

  // Page selector
  getEl('page-select').addEventListener('change', (e) => {
    const pageNum = parseInt(e.target.value);
    displayPage(pageNum);
    jumpToFirstAyahOfPage(pageNum);
  });

  // Ayah selector
  getEl('ayah-select').addEventListener('change', (e) => {
    const ayahNo = parseInt(e.target.value);
    if (!ayahNo) return;

    const ayahData = state.quranData.find(
      (item) => item.sura_no === state.currentSura && item.aya_no === ayahNo,
    );

    if (!ayahData) return;

    const ayahPage = parseInt(ayahData.page.split('-')[0]);
    if (ayahPage !== state.currentPage) {
      displayPage(ayahPage, true);
      setTimeout(() => selectAndPlayAyah(ayahData), 200);
    } else {
      selectAndPlayAyah(ayahData);
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
      displayPage(newPage);
      if (
        state.isPlaying ||
        (state.audioPlayer?.src && state.audioPlayer.src !== '')
      ) {
        jumpToFirstAyahOfPage(newPage);
      }
    }
  });

  getEl('next-page').addEventListener('click', () => {
    if (state.currentPage < TOTAL_PAGES) {
      const newPage = state.currentPage + 1;
      displayPage(newPage);
      if (
        state.isPlaying ||
        (state.audioPlayer?.src && state.audioPlayer.src !== '')
      ) {
        jumpToFirstAyahOfPage(newPage);
      }
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

    // Arrow Left → seek forward 5 s
    if (
      e.code === 'ArrowLeft' &&
      state.audioPlayer?.src &&
      state.audioPlayer.src !== ''
    ) {
      e.preventDefault();
      state.audioPlayer.currentTime = Math.min(
        state.audioPlayer.currentTime + 5,
        state.audioPlayer.duration || 0,
      );
      return;
    }

    // Arrow Right → seek backward 5 s
    if (
      e.code === 'ArrowRight' &&
      state.audioPlayer?.src &&
      state.audioPlayer.src !== ''
    ) {
      e.preventDefault();
      state.audioPlayer.currentTime = Math.max(
        state.audioPlayer.currentTime - 5,
        0,
      );
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
