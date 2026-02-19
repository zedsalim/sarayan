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

document.addEventListener('DOMContentLoaded', async () => {});
