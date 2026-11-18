# Zdroje balíka LAWOSS

Všetky súbory sú prevzaté bez úprav, ak nie je uvedené inak. Fonty sú pod licenciou SIL Open Font License 1.1, plné znenie je v `fonts/OFL.txt`. Font General Sans ani grafika SKALLARS sa v balíku nepoužívajú.

| Súbor | Zdroj | Verzia | SHA-256 |
|---|---|---|---|
| `mark.svg` | `Omni-Legal-Products/lawoss`, `lawoss/brand/lawoss-mark.svg` | commit `da72c2b138611e4e72d3e327640c0bc795f29ad8` | `d89fee21741ed8713a048b113849f72fb28f43861f77c6666d441a8bdea4a767` |
| `fonts/IBMPlexSans-Variable.woff2` | npm `@ibm/plex-sans-variable` (IBM, oficiálny balík IBM Plex), `fonts/complete/woff2/IBM Plex Sans Var-Roman.woff2` | 0.2.0, tarball SHA-256 `6deffdab81404ee07dbe8d3044a8540aa0c3f02ca94996936f5dc55e11de4c20` | `e978248b6b56da9e372975322a98dd9a51135d1b375e32ed6d5ca69f3aab792d` |
| `fonts/IBMPlexMono-Regular.woff2` | npm `@ibm/plex-mono` (IBM, oficiálny balík IBM Plex), `fonts/complete/woff2/IBMPlexMono-Regular.woff2` | 2.5.0, tarball SHA-256 `55b5ffcfcd5e9db36ef2070b2b07a573434ca02c6f3be2b921c0b88fff29acad` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `fonts/InstrumentSerif-Regular.woff2` | GitHub `Instrument/instrument-serif`, `fonts/webfonts/InstrumentSerif-Regular.woff2` | commit `65c0ef225f386a3c7e87570a4aa9cc0262c2fd81` | `ca21b99b0d6b88a0dc34cebfe48104611e5c7f8f92746bed26c37aa470174322` |
| `fonts/OFL.txt` | Spojenie `LICENSE.txt` z `@ibm/plex-sans-variable` 0.2.0 (zhodný s `@ibm/plex-mono` 2.5.0) a `OFL.txt` z `Instrument/instrument-serif` (SHA-256 `129ed7618959716959f2941fdd5b49e0ad6e6c1d78726761786a00253d865521`) | ako vyššie | `0e6989b00c5fa41b7c348184b775bc2880c5a3af0c3f1764842abe333051a2ea` |

## Odvodené súbory

- `logo.svg` a `logo-dark.svg` skladajú `mark.svg` a kreslený wordmark LAWOSS z `Omni-Legal-Products/lawoss-web`, `site/src/components/Wordmark.tsx`, commit `915bc021e36d1947b2f43f6f0dc6cae9c4dae71e`. Cesty sú prevzaté bez zmeny, zmenené je iba umiestnenie a farba ťahu (`#0A0E14` pre svetlé pozadie, `#F4F1EA` pre tmavé). Pomer značky a wordmarku zodpovedá logu na webe LAWOSS.
- `tokens.css` preberá farby z `docs/distribution-model.html` v `Omni-Legal-Products/lawoss-marketplace` (plocha `#f4f1ea`, text `#0a0e14`, linky a sekundárna farba `#42586e`) a zlatú zo značky.
- `preview/` obsahuje snímky šiestich stavov z `node dist/preview.js` s týmto balíkom: desktop 1440 × 900 a mobil 390 × 844 pri hustote 2. Server ich neposkytuje.

## Pokrytie znakov

Všetky tri fonty obsahujú slovenskú diakritiku. Instrument Serif nemá šípky `→` a `↗`, tie však používajú iba tlačidlá a zoznam v IBM Plex Sans.
