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

Known traps: SingleFile, MinIO, Duende IdentityServer, MediatR/AutoMapper (newer versions), MassTransit v9+, FluentAssertions v8+, ImageSharp, Redis 7.4+ (use Valkey).

## Commits
Make one focused commit per feature, and keep the build and tests passing on every commit.
