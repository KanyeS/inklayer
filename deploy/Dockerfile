# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f deploy/Dockerfile -t inklayer-server .

# Web viewer: static files that end up in the server's wwwroot.
FROM --platform=$BUILDPLATFORM node:22-alpine AS client
WORKDIR /src/client
COPY client/ ./
RUN npm ci --no-audit --no-fund \
 && npm run build -w @inklayer/viewer

# The SDK stage runs on the build machine's own architecture and cross-compiles for the
# target (amd64/arm64). Multi-arch images build fast, with no QEMU emulation.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG VERSION=0.0.0-dev
ARG TARGETARCH
WORKDIR /src

# Restore first so the layer is cached when only source code changes.
COPY server/global.json server/Directory.Build.props server/Directory.Packages.props server/Inklayer.slnx server/
COPY server/src/Inklayer.Domain/Inklayer.Domain.csproj server/src/Inklayer.Domain/
COPY server/src/Inklayer.Infrastructure/Inklayer.Infrastructure.csproj server/src/Inklayer.Infrastructure/
COPY server/src/Inklayer.Api/Inklayer.Api.csproj server/src/Inklayer.Api/
RUN dotnet restore server/src/Inklayer.Api/Inklayer.Api.csproj -a $TARGETARCH

# Analyzer settings live in the repository root's .editorconfig.
COPY .editorconfig ./
COPY server/src/ server/src/
COPY --from=client /src/server/src/Inklayer.Api/wwwroot server/src/Inklayer.Api/wwwroot
RUN dotnet publish server/src/Inklayer.Api/Inklayer.Api.csproj \
      -c Release --no-restore -a $TARGETARCH --no-self-contained -o /app \
      -p:Version=${VERSION} -p:InformationalVersion=${VERSION}
# Chiseled images have no shell, so the data directory is prepared here.
RUN mkdir -p /data-root/data

# Chiseled image: no shell or package manager, and it runs as a non-root user (uid 1654).
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled AS final
WORKDIR /app
COPY --from=build /app .
# /data holds the SQLite database and stored snapshots. Mount a volume here.
# A fresh named volume inherits this ownership, so the non-root user can write to it.
COPY --from=build --chown=1654:1654 /data-root/data /data
# Workstation GC + conserve-memory keep the footprint small (the server targets 512 MB hosts).
ENV ASPNETCORE_HTTP_PORTS=8080 \
    ConnectionStrings__Database="Data Source=/data/inklayer.db" \
    DOTNET_gcServer=0 \
    DOTNET_GCConserveMemory=5 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
EXPOSE 8080
VOLUME ["/data"]
USER 1654
ENTRYPOINT ["dotnet", "Inklayer.Api.dll"]
