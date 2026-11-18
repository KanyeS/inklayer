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

Known traps: SingleFile, MinIO, Duende IdentityServer, MediatR/AutoMapper (newer versions), MassTransit v9+, FluentAssertions v8+, ImageSharp, Redis 7.4+ (use Valkey).

## Commits
Make one focused commit per feature, and keep the build and tests passing on every commit.
