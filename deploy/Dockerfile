# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f deploy/Dockerfile -t inklayer-server .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG VERSION=0.0.0-dev
WORKDIR /src

# Restore first so the layer is cached when only source code changes.
COPY server/global.json server/Directory.Build.props server/Directory.Packages.props server/Inklayer.slnx server/
COPY server/src/Inklayer.Domain/Inklayer.Domain.csproj server/src/Inklayer.Domain/
COPY server/src/Inklayer.Infrastructure/Inklayer.Infrastructure.csproj server/src/Inklayer.Infrastructure/
COPY server/src/Inklayer.Api/Inklayer.Api.csproj server/src/Inklayer.Api/
RUN dotnet restore server/src/Inklayer.Api/Inklayer.Api.csproj

COPY server/src/ server/src/
RUN dotnet publish server/src/Inklayer.Api/Inklayer.Api.csproj \
      -c Release --no-restore -o /app \
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
ENV ASPNETCORE_HTTP_PORTS=8080 \
    ConnectionStrings__Database="Data Source=/data/inklayer.db" \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
EXPOSE 8080
VOLUME ["/data"]
USER 1654
ENTRYPOINT ["dotnet", "Inklayer.Api.dll"]
