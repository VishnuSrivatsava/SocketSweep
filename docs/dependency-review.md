# Dependency reviews — October 2026

This records the npm review on 17 October and Rust review on 20 October for
[#44](https://github.com/VishnuSrivatsava/SocketSweep/issues/44).
Remaining upstream warnings are tracked in
[#63](https://github.com/VishnuSrivatsava/SocketSweep/issues/63).
Neither review establishes that the application has no security vulnerabilities.

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

The npm change left the Rust lockfile untouched. The follow-up below addresses
its compatible security updates and records the remaining warnings separately.

## Rust lockfile update — 20 October

The existing Tauri, Tauri-codegen, and Tauri-utils manifests accept `plist = "1"`.
Updating that transitive dependency avoids an override or a framework upgrade:

| Package | Before | After |
| --- | --- | --- |
| `plist` | 1.9.0 | 1.10.2 |
| `quick-xml` | 0.39.4 | 0.42.0 |
| `anyhow` | 1.0.102 | 1.0.103 |
| plist's `base64` | 0.22.1 | 0.23.1; other dependencies retain their existing versions |

Application dependency changes are confined to `Cargo.lock`. Direct dependency declarations and all Tauri versions
remain unchanged. Plist's declared minimum Rust version remains 1.88.0.
[Plist's release notes](https://github.com/ebarnard/rust-plist/blob/v1.10.2/CHANGELOG.md)
record its parser/dependency changes, including the required base64 update.

The fixed advisory boundaries are:

- [RUSTSEC-2026-0194](https://rustsec.org/advisories/RUSTSEC-2026-0194.html):
  duplicate-attribute checking can take quadratic CPU time; fixed in quick-xml
  >=0.41.0.
- [RUSTSEC-2026-0195](https://rustsec.org/advisories/RUSTSEC-2026-0195.html):
  unbounded namespace-declaration allocation in `NsReader`; fixed in quick-xml
  >=0.41.0.
- [RUSTSEC-2026-0190](https://rustsec.org/advisories/RUSTSEC-2026-0190.html):
  an unsound mutable downcast after adding error context; fixed in anyhow
  >=1.0.103. This is an informational unsoundness warning in cargo-audit,
  separate from its vulnerability entries.

### Audit method and results

Built `cargo-audit` 0.22.2 from its locked published source into a temporary tools
directory; it is not a project/runtime dependency. Audited a saved original
lockfile and the updated lockfile against the same freshly fetched RustSec
database, commit `999ec89d5d3f10f20be14750ec8c2d8b44e0ac9b` (1,338 advisories,
database last updated 17 October). The second audit used `--no-fetch`; the
database Git commit was checked again afterward. No target, architecture,
severity, or advisory-ignore filter was applied.

| cargo-audit category | Before | After |
| --- | --- | --- |
| Vulnerability entries | 2 (quick-xml) | 0 |
| Unsoundness warnings | 2 (anyhow, GLib) | 1 (GLib) |
| Unmaintained-package warnings | 6 | 6 |

The default post-update audit exits successfully **with seven warnings**. It
must not be described as a clean bill of health. Repeat with an installed audit
tool using `cargo audit --file src-tauri/Cargo.lock --json`; adding
`--deny warnings` intentionally fails until the remaining findings are resolved.
Future database updates can change these snapshot counts.

### Input-path assessment

The inspected Tauri 2.11.1 source reads a macOS application's own
`Contents/Info.plist` in its restart helper. Tauri-codegen 2.6.1 optionally reads
the project's `Info.plist` during macOS development context generation.
Tauri-utils 2.9.1 also constructs plist values for file-association metadata.
SocketSweep's source has no direct plist/quick-xml calls, no restart call, and
parses the device scan stream as JSON, not XML.

Plist 1.9.0's inspected XML reader uses quick-xml's plain `Reader`, not
`NsReader`, and its event handling does not iterate start-tag attributes.
Those observations do not demonstrate either advertised attack path through
SocketSweep. They are source-path findings, not a proof that arbitrary XML is
safe or that every dependency path is unreachable. Patched dependencies still
remove the affected versions from the lockfile. No direct `downcast_mut` call
was found in SocketSweep or the inspected Tauri/runtime/Wry sources; anyhow is
updated rather than relying on that limited search as a safety guarantee.

### Remaining warnings and follow-up

| Package | Advisory | Observed dependency path / action |
| --- | --- | --- |
| `glib` 0.18.5 | [2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | Linux GTK/WebKit runtime; investigate a supported framework fix or backport. |
| `proc-macro-error` 1.0.4 | [2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | Linux `glib-macros` / `gtk3-macros` build-time code; track supported macro replacements. |
| `unic-char-property` 0.9.0 | [2025-0081](https://rustsec.org/advisories/RUSTSEC-2025-0081.html) | Tauri-utils → urlpattern; review supported replacement and URL/capability behavior. |
| `unic-char-range` 0.9.0 | [2025-0075](https://rustsec.org/advisories/RUSTSEC-2025-0075.html) | Same urlpattern chain. |
| `unic-common` 0.9.0 | [2025-0080](https://rustsec.org/advisories/RUSTSEC-2025-0080.html) | Same urlpattern chain. |
| `unic-ucd-ident` 0.9.0 | [2025-0100](https://rustsec.org/advisories/RUSTSEC-2025-0100.html) | Same urlpattern chain. |
| `unic-ucd-version` 0.9.0 | [2025-0098](https://rustsec.org/advisories/RUSTSEC-2025-0098.html) | Same urlpattern chain. |

GLib's affected iterator functions are a real unresolved correctness risk. The
advisory requires >=0.20.0, while GTK 0.18.2 requires GLib 0.18. SocketSweep has
no direct GLib calls, and no direct `VariantStrIter`/`array_iter_str` call was
found in the inspected Tauri/runtime/Wry roots. That does not rule out transitive
runtime reachability. Forcing another GLib version would not replace GTK's
affected copy.

The proc-macro warning concerns compilation of project/dependency Rust code.
The UNIC warnings concern maintenance of the URL-pattern parser's Unicode
support. Tauri uses that parser for remote capability patterns; the current
default capability declares none. These narrower observed paths are not a
general non-reachability proof and do not justify ignoring warnings.

[#63](https://github.com/VishnuSrivatsava/SocketSweep/issues/63) records remediation
options and required validation for all seven findings. No advisory ignores,
patched crate forks, or incompatible overrides are introduced. The fork's native
ADB/crypto dependencies remain a separate review if that client is proposed for
adoption; it is not part of the current dependency graph.

All 33 Rust library tests pass with the updated lockfile. Three-platform locked
builds and packaging CI exercise the framework integration. No native app,
Android daemon, ADB command, or phone test is run locally for this update.

## Release refresh — 29 October

For the v1.2.0 candidate (#108), repeated the full `npm audit --json` against the
current lockfile: zero reported findings. Built cargo-audit 0.22.2 from its
locked published source into a temporary tools directory and fetched RustSec
commit `40f5be6fb12ed93fc591bf4ab23b7d793b3f2239` (1,381 advisories; last update
28 October). No advisory ignores, target filters or severity filters were used.

The refreshed audit found one additional informational unsoundness warning:
Tokio 1.52.3 is affected by
[RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html), concerning
I/O safety in `AsyncFd` constructors. Updated the transitive Tokio package to
the compatible patched boundary 1.53.3; no direct dependency, override or
framework upgrade was added. Its declared Rust minimum is 1.71, below this
project's 1.89 requirement. The lockfile delta changes only Tokio's version and
checksum; unrelated dependency bindings remain unchanged.

The upstream fix deprecates the affected safe constructors in favor of unsafe
registration with explicit file-descriptor lifetime obligations. SocketSweep
has no direct `AsyncFd` calls. That source observation is not a complete
transitive reachability or correctness proof, and an audit finding disappearing
does not establish universal I/O safety.

Auditing the updated lockfile with `--no-fetch` against the same database gives:

| cargo-audit category | Before Tokio update | After |
| --- | --- | --- |
| Vulnerability entries | 0 | 0 |
| Unsoundness warnings | 2 (Tokio, GLib) | 1 (GLib) |
| Unmaintained-package warnings | 6 | 6 |

The seven existing GLib/proc-macro-error/UNIC warnings remain open in #63.
[Tauri's own advisory configuration at the reviewed upstream commit](https://github.com/tauri-apps/tauri/blob/548a3692f59405aeb239c5b63fa589824eee51e8/.cargo/audit.toml)
still records the GLib 0.18.5 warning and identifies GTK4 as its upgrade path.
SocketSweep does not copy those suppressions or claim an unsupported GLib
replacement resolves GTK's copy. This refresh is a dated dependency review,
not a security certification or a physical-device validation result.
