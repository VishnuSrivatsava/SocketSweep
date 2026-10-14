# Bundled fonts

SocketSweep ships normal-style Inter (weights 300–800) and JetBrains Mono
(weights 400–500), matching the previous Google Fonts stylesheet. Variable
WOFF2 subsets cover Latin, extended Latin, Vietnamese, Greek and Cyrillic;
Inter also includes extended Greek. Keeping these subsets preserves the
previous stylesheet's coverage for filenames as well as English UI text.
Characters absent from these families still use the existing system fallback
stacks, which can differ between platforms. No italic faces are used or shipped.

The files are unmodified Google Fonts distributions downloaded from this
[CSS request](https://fonts.googleapis.com/css2?family=Inter:wght@300..800&family=JetBrains+Mono:wght@400..500&display=swap)
with a modern Chromium user agent. `font-assets.json` records each exact source
URL, byte count and SHA-256 digest. The SIL Open Font License files come from
[google/fonts at 66928797f271fed5ee428544e7229685e2d90127](https://github.com/google/fonts/tree/66928797f271fed5ee428544e7229685e2d90127/ofl).
They are copied into the desktop frontend at `/font-licenses/inter-OFL.txt`
and `/font-licenses/jetbrainsmono-OFL.txt`, alongside the bundled fonts.
Neither development nor release builds download fonts.

Vite emits hashed asset URLs from `src/fonts.css`. Its `?no-inline` suffix
keeps even the smallest font as a separate asset: the production CSP permits
only `font-src 'self'`, so embedded data fonts would be blocked. The app retains
`font-display: swap` and its system fallback stacks for the brief initial load.
Google Fonts links and preconnects are removed; no external font origins or
new dependencies are needed.

## Asset accounting

Production `dist` file bytes, compared with commit
`6bfefba9f5cda9b337b4f0badcf1eaa3dd3d8642` using the same installed toolchain:

| Assets | Before | After |
| --- | ---: | ---: |
| JavaScript | 516,736 | 516,736 |
| CSS | 32,112 | 35,495 |
| WOFF2 fonts | 0 | 284,804 |
| Font licenses | 0 | 8,776 |
| All frontend files, including HTML and existing SVGs | 560,055 | 856,716 |

The total increase is 296,661 bytes (about 290 KiB). These are uncompressed
frontend file sizes, not installer sizes or memory measurements. The previous
zero font bytes meant fonts were fetched externally or blocked, not free.

## Verification

Run `npm run build`, then `python3 tests/check_scan_ui.py`. The existing built-UI
fixture runs headless Chromium with mocked IPC, external DNS disabled, and the
production CSP (with a local report endpoint allowed in `connect-src`). It no
longer removes remote font links from the page, so regressions cannot be hidden.
It loads every shipped subset at each declared weight, verifies the faces
loaded, checks all 13 font URLs stay on the local origin, rejects CSP violations,
and checks setup alignment and result typography alongside scan UI behavior.

Additional scale checks:

```sh
UI_TEST_WINDOW=1024,768 python3 tests/check_scan_ui.py
UI_TEST_SCALE=2 python3 tests/check_scan_ui.py
```

The default is 1280×1000 at 1×. These are browser fixture checks, not native
WebKit/WebView or connected-phone tests. Manual native verification uses
`npm run tauri dev`; disconnect internet access and check setup, results and
logs. No daemon rebuild is needed for this change.
