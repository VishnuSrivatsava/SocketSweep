# Dependency review — 17 October 2026

This is the npm portion of
[#44](https://github.com/VishnuSrivatsava/SocketSweep/issues/44).
It does not complete the Rust review or establish that the application has no
security vulnerabilities.

## npm lockfile update

The same-day before/after `npm audit --json` results were:

| Scope | Before | After |
| --- | --- | --- |
| Full dependency graph | 8 affected packages: 5 high, 1 moderate, 2 low | 0 reported findings |
| `--omit=dev` | 5 affected packages: 4 high, 1 low | 0 reported findings |

Counts refer to affected packages, not unique advisories. Results depend on the
registry's advisory data at the time of the request.

| Previously flagged package | Before | After |
| --- | --- | --- |
| `vite` | 7.3.3 | 7.3.7 |
| `@babel/core` | 7.29.0 | 7.29.7 |
| `baseline-browser-mapping` | 2.10.29 | 2.11.29 |
| `browserslist` | 4.28.2 | 4.29.3 |
| `esbuild` | 0.27.7 | 0.28.2 |
| `nanoid` | 3.3.12 | 3.3.20 |
| `postcss` | 8.5.14 | 8.5.30 |
| `source-map-js` | 1.2.1 | 1.2.2 |

The update used the standard
[`npm audit fix --package-lock-only --ignore-scripts`](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
followed by a clean `npm ci`. All direct dependency ranges in `package.json`
remain unchanged. There are no overrides, advisory suppressions, or forced major
upgrades. Related Babel/browser-target data and esbuild platform packages update
with their owning dependencies. Vite 7.3.7 permits esbuild 0.28 through its own
dependency range; this is not an application-level esbuild override. npm also
resolved six nested optional WASM-support dependencies for the existing
Tailwind package. No React, Recharts, Tailwind, or native application dependency
version was changed.

## Exposure and limits

These findings occur in the build/development toolchain. `npm explain` traces
PostCSS/nanoid through Vite, source-map-js through PostCSS and Tailwind's Node
plugin, and Babel/browser-target data through the React Vite plugin. Five
packages also appear in `--omit=dev` because `@tailwindcss/vite` is listed under
`dependencies` and brings Vite's toolchain into that graph. Manifest placement
was not changed to hide findings.

The production Tauri configuration bundles `dist` plus the explicit ADB/daemon
resources. It does not start Vite's development server. The app source does not
import these tools at runtime; `vite-env.d.ts` has only a type reference. This
review has not demonstrated exploitation through a device scan.

[Vite's Windows deny-list bypass advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
identifies 7.3.5 as a patched version on the Vite 7 line. The project's dev server
defaults to loopback but can bind another host through `TAURI_DEV_HOST`, so
development-server findings still matter. Build tools also process repository
source and source maps; a packaged-runtime assessment does not make vulnerable
build tools harmless.

## Validation and remaining work

`npm ci`, `npm ls --all`, all 43 Node tests, and `npm run build` passed locally.
There were no dependency-tree problems. Before/after local builds both contained
21 files totaling 857,660 bytes; JavaScript content was byte-identical. Generated
asset filenames and CSS hashes changed, so the complete build is not claimed
byte-identical. These are local artifact checks, not device performance results.
The existing headless replay and three-platform packaging CI validate the new
toolchain without an attached phone or launching the native app.

The Rust lockfile is unchanged. Its `quick-xml` 0.39.4 findings remain unresolved:
[RUSTSEC-2026-0194](https://rustsec.org/advisories/RUSTSEC-2026-0194.html) and
[RUSTSEC-2026-0195](https://rustsec.org/advisories/RUSTSEC-2026-0195.html) identify
0.41.0 as the patched boundary. This requires reviewing the plist/Tauri dependency
constraints and the actual XML input paths, not pretending a 0.39 patch update
fixes them. A current `cargo audit` run and remaining Rust
maintenance/unsoundness warnings are still part of #44; `cargo-audit` was not
installed in the local environment during this npm-only change.
