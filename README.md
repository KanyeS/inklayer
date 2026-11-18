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

## Self-hosting

```bash
cd deploy
docker compose up -d          # serves on http://localhost:8080
```

All data (the SQLite database and snapshots) lives on the `inklayer-data` volume. Run a single replica on local disk, and put a TLS reverse proxy in front (see `deploy/Caddyfile.example`).

## Development

Requires the .NET 10 SDK.

```bash
cd server
dotnet test                                  # unit + integration tests
dotnet run --project src/Inklayer.Api        # http://localhost:5048 (DB at server/.data/)
```

| Endpoint | Purpose |
|---|---|
| `/health/live` | Process is up |
| `/health/ready` | Database reachable |
| `/openapi/v1.json` | OpenAPI document |
| `/api/system/version` | Server version |

Licence check: `dotnet tool restore && dotnet nuget-license -i Inklayer.slnx -t -a ../.github/licenses/allowed-licenses.json -override ../.github/licenses/nuget-overrides.json`

## Licence

[Apache-2.0](LICENSE). Every dependency must use a permissive licence that allows commercial use (MIT, Apache-2.0, BSD, ISC). CI enforces this. See [CONTRIBUTING.md](CONTRIBUTING.md).
