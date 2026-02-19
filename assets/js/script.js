// ─── Constants ────────────────────────────────────────────────────────────────
const TOTAL_PAGES = 604;
const SURAH_NO_BASMALA = 9; // Surah At-Tawbah has no Basmala

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  quranData: [],
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

/** Show a non-blocking toast notification instead of alert() */
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
  initializeSelectors();
});

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

