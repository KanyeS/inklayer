# Contributing to Inklayer

## Sign-off (DCO)
Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s
```

## Dependency licences
Only add dependencies that use permissive licences: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD or PostgreSQL.
GPL/AGPL/LGPL, SSPL, BSL and other "source-available" or commercial licences are not accepted.
Build-only exceptions for npm: `lightningcss` (MPL-2.0, Vite's CSS minifier) and the `spdx-*` data packages (CC-BY-3.0) run only at build time and are never included in the extension. The extension bundle must contain only our own code plus permissively licensed runtime dependencies.
`fetch-cookie` (Unlicense) is a Node-only dependency of `@microsoft/signalr`: SignalR only `require`s it when running under Node, so it is never bundled into the extension, and the licence check skips it.
The server edits docs with YDotNet (MIT), bindings to Yjs's Rust core (yrs). `YDotNet.Native.Linux` adds a native library (`libyrs.so`, glibc x64 and arm64) to the published app; it needs only libc and libgcc_s, both in the chiseled .NET image. Docs are Yjs documents, so this is what lets the MCP tools edit them alongside people in the browser.
`argparse` (PSF-2.0) is used only by `markdown-it`'s command-line tool, never by the library the viewer bundles, so the licence check skips it too.
Viewer runtime exceptions, for mermaid diagrams in docs:
- `elkjs` (offered as EPL-2.0 or GPL-3.0-or-later; we use it under EPL-2.0) is mermaid 12's layout engine. EPL-2.0 is weak copyleft: it covers only elkjs's own files, so our code stays Apache-2.0. It must stay unmodified (changes to it would have to be published under EPL-2.0), and its licence and source location ship with the viewer as `/third-party-notices.txt` (written by `apps/viewer/vite.config.ts`). Note EPL-2.0's section 4: anyone distributing Inklayer as part of a commercial offering takes on an indemnity towards elkjs's contributors.
- `robust-predicates` (Unlicense, a public-domain dedication like CC0) comes with d3, which mermaid uses.
The client licence check allows `EPL-2.0` and `Unlicense` for these; don't add other packages under them without the same review.

Known traps: SingleFile, MinIO, Duende IdentityServer, MediatR/AutoMapper (newer versions), MassTransit v9+, FluentAssertions v8+, ImageSharp, Redis 7.4+ (use Valkey).

## Client code (TypeScript)
- **Lint and format with Biome** (`client/biome.json`): `npm run lint` checks, `npm run format` fixes. CI fails on any finding. A rule may be suppressed only with `// biome-ignore <rule>: <why>` on the line, saying why it's right there.
- **Architecture tests** (`client/test/architecture.test.ts`) read the source and enforce the layout: no file over 800 lines; no stylesheets in TypeScript strings (shadow-DOM styles live in `.css` files imported with `?inline`); no dead CSS in the panel's and docs' stylesheets; apps don't import each other's source (share code through `packages/`); content scripts don't pull in React; the extension's page requests match what the background handles. If one fails, fix the structure rather than the test.
- **Pure logic goes in its own module with a unit test.** A module whose doc comment says it's unit-tested must have a test that imports it (checked by the architecture tests).
- **Shared code:** DOM helpers (`h`, `lineIcon`, `copyText`, `shadowTokens`, `followColorScheme`) are in `@inklayer/overlay`; the docs core (Markdown, editor, formatting) is in `@inklayer/docs`; theme and components in `@inklayer/ui`.

## Commits
Make one focused commit per feature, and keep the build and tests passing on every commit.
