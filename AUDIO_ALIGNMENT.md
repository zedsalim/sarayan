# Audio Alignment

## Source

Recitation: **Abdelbasset Abdessamad (Warsh)**
Original download: [https://www.versebyversequran.com/](https://www.versebyversequran.com/)

Text reference (source of truth):

```
assets/text/UthmanicWarsh/warshData_v2-1.json
```

Based on:

- King Fahd Glorious Qur'an Printing Complex
- Uthmanic Warsh v2-1

---

## Alignment Summary

A comparison was performed between:

```
assets/audio/abdelbasset_abdessamad
```

and `warshData_v2-1.json`.

Results:

- 114 surahs scanned
- 6214 MP3 files analyzed

### Adjustments Made

- **Surah 26 (Ash-Shu'ara)**
  One extra split → concatenated 210.mp3 + 211.mp3

- **Surah 67 (Al-Mulk)**
  One missing boundary → split 009.mp3 at 8.25s and renumbered

---

## Final Status

- 114/114 surahs aligned
- Exact ayah count match
- 1:1 mapping with Warsh JSON v2-1
- No content edits — segmentation only
