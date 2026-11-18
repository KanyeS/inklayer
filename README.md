# Inklayer

Open-source, self-hosted web page annotation for UX designers, developers and QA.

Capture any web page with the Chrome extension. Then comment on it, highlight it or draw on it, either on specific elements or freehand. Every change is kept with a full history and timestamps. Access is controlled by roles, and sign-in uses Google SSO.

> **Status:** early development. Nothing is usable yet. See [docs/PLAN.md](docs/PLAN.md) for the design and roadmap.

## Components

| Path | What it is |
|---|---|
| `server/` | ASP.NET Core (.NET 10) API, auth, real-time hub, snapshot host |
| `client/apps/extension/` | Chrome extension (Manifest V3) for capture and annotation |
| `client/apps/viewer/` | Web viewer for captured pages |
| `client/packages/` | Shared TypeScript packages (overlay, capture, API client) |
| `deploy/` | Dockerfile, docker-compose, reverse-proxy examples |

## Licence

[Apache-2.0](LICENSE). Every dependency must use a permissive licence that allows commercial use (MIT, Apache-2.0, BSD, ISC). CI enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md).
