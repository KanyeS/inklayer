using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RemoveSnapshots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Snapshots are removed, and comments drawn on them go with them (their history too).
            migrationBuilder.Sql("DELETE FROM AnnotationRevisions WHERE AnnotationId IN (SELECT Id FROM Annotations WHERE PageUrl IS NULL);");
            migrationBuilder.Sql("DELETE FROM Annotations WHERE PageUrl IS NULL;");

            migrationBuilder.DropForeignKey(
                name: "FK_Annotations_Snapshots_SnapshotId",
                table: "Annotations");

            migrationBuilder.DropTable(
                name: "OrganizationBlobs");

            migrationBuilder.DropTable(
                name: "SnapshotAssets");

            migrationBuilder.DropTable(
                name: "Snapshots");

            migrationBuilder.DropIndex(
                name: "IX_Annotations_SnapshotId_CreatedAt",
                table: "Annotations");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Annotations_SnapshotOrPage",
                table: "Annotations");

            migrationBuilder.DropColumn(
                name: "SnapshotId",
                table: "Annotations");

            migrationBuilder.AlterColumn<string>(
                name: "PageUrl",
                table: "Annotations",
                type: "TEXT",
                maxLength: 2048,
                nullable: false,
                defaultValue: "",
                oldClrType: typeof(string),
                oldType: "TEXT",
                oldMaxLength: 2048,
                oldNullable: true);

            migrationBuilder.AddForeignKey(
                name: "FK_Annotations_Projects_ProjectId",
                table: "Annotations",
                column: "ProjectId",
                principalTable: "Projects",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Annotations_Projects_ProjectId",
                table: "Annotations");

            migrationBuilder.AlterColumn<string>(
                name: "PageUrl",
                table: "Annotations",
                type: "TEXT",
                maxLength: 2048,
                nullable: true,
                oldClrType: typeof(string),
                oldType: "TEXT",
                oldMaxLength: 2048);

            migrationBuilder.AddColumn<Guid>(
                name: "SnapshotId",
                table: "Annotations",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "OrganizationBlobs",
                columns: table => new
                {
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Hash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    Size = table.Column<long>(type: "INTEGER", nullable: false)
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
                    CapturedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    CapturedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    DevicePixelRatio = table.Column<double>(type: "REAL", nullable: false),
                    DocumentHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ProjectId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ScreenshotContentType = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    ScreenshotHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    ScrollX = table.Column<int>(type: "INTEGER", nullable: false),
                    ScrollY = table.Column<int>(type: "INTEGER", nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    TotalBytes = table.Column<long>(type: "INTEGER", nullable: false),
                    Url = table.Column<string>(type: "TEXT", maxLength: 4096, nullable: false),
                    UserAgent = table.Column<string>(type: "TEXT", maxLength: 512, nullable: true),
                    ViewportHeight = table.Column<int>(type: "INTEGER", nullable: false),
                    ViewportWidth = table.Column<int>(type: "INTEGER", nullable: false)
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
                name: "IX_Annotations_SnapshotId_CreatedAt",
                table: "Annotations",
                columns: new[] { "SnapshotId", "CreatedAt" });

            migrationBuilder.AddCheckConstraint(
                name: "CK_Annotations_SnapshotOrPage",
                table: "Annotations",
                sql: "(SnapshotId IS NULL) <> (PageUrl IS NULL)");

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

            migrationBuilder.AddForeignKey(
                name: "FK_Annotations_Snapshots_SnapshotId",
                table: "Annotations",
                column: "SnapshotId",
                principalTable: "Snapshots",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
