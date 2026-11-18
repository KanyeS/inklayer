using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Snapshots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "OrganizationBlobs",
                columns: table => new
                {
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Hash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    Size = table.Column<long>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrganizationBlobs", x => new { x.OrganizationId, x.Hash });
                    table.ForeignKey(
                        name: "FK_OrganizationBlobs_Organizations_OrganizationId",
                        column: x => x.OrganizationId,
                        principalTable: "Organizations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Snapshots",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    ProjectId = table.Column<Guid>(type: "TEXT", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Url = table.Column<string>(type: "TEXT", maxLength: 4096, nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    ViewportWidth = table.Column<int>(type: "INTEGER", nullable: false),
                    ViewportHeight = table.Column<int>(type: "INTEGER", nullable: false),
                    DevicePixelRatio = table.Column<double>(type: "REAL", nullable: false),
                    ScrollX = table.Column<int>(type: "INTEGER", nullable: false),
                    ScrollY = table.Column<int>(type: "INTEGER", nullable: false),
                    UserAgent = table.Column<string>(type: "TEXT", maxLength: 512, nullable: true),
                    DocumentHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    ScreenshotHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    ScreenshotContentType = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    TotalBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    CapturedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CapturedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Snapshots", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Snapshots_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SnapshotAssets",
                columns: table => new
                {
                    SnapshotId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Hash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    ContentType = table.Column<string>(type: "TEXT", maxLength: 128, nullable: false),
                    Size = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SnapshotAssets", x => new { x.SnapshotId, x.Hash });
                    table.ForeignKey(
                        name: "FK_SnapshotAssets_Snapshots_SnapshotId",
                        column: x => x.SnapshotId,
                        principalTable: "Snapshots",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_OrganizationBlobs_Hash",
                table: "OrganizationBlobs",
                column: "Hash");

            migrationBuilder.CreateIndex(
                name: "IX_SnapshotAssets_Hash",
                table: "SnapshotAssets",
                column: "Hash");

            migrationBuilder.CreateIndex(
                name: "IX_Snapshots_OrganizationId",
                table: "Snapshots",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_Snapshots_ProjectId_CapturedAt",
                table: "Snapshots",
                columns: new[] { "ProjectId", "CapturedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "OrganizationBlobs");

            migrationBuilder.DropTable(
                name: "SnapshotAssets");

            migrationBuilder.DropTable(
                name: "Snapshots");
        }
    }
}
