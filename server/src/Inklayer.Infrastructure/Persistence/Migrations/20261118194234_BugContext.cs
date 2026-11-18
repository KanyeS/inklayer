using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class BugContext : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AnnotationContexts",
                columns: table => new
                {
                    AnnotationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Browser = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    Os = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    UserAgent = table.Column<string>(type: "TEXT", maxLength: 512, nullable: false),
                    ViewportWidth = table.Column<int>(type: "INTEGER", nullable: false),
                    ViewportHeight = table.Column<int>(type: "INTEGER", nullable: false),
                    DevicePixelRatio = table.Column<double>(type: "REAL", nullable: false),
                    Selector = table.Column<string>(type: "TEXT", maxLength: 2000, nullable: false),
                    ElementHtml = table.Column<string>(type: "TEXT", maxLength: 8192, nullable: false),
                    Console = table.Column<string>(type: "TEXT", maxLength: 16384, nullable: false),
                    Network = table.Column<string>(type: "TEXT", maxLength: 16384, nullable: false),
                    CapturedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AnnotationContexts", x => x.AnnotationId);
                    table.ForeignKey(
                        name: "FK_AnnotationContexts_Annotations_AnnotationId",
                        column: x => x.AnnotationId,
                        principalTable: "Annotations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "AnnotationScreenshots",
                columns: table => new
                {
                    AnnotationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ContentType = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    Bytes = table.Column<byte[]>(type: "BLOB", nullable: false),
                    Width = table.Column<int>(type: "INTEGER", nullable: false),
                    Height = table.Column<int>(type: "INTEGER", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AnnotationScreenshots", x => x.AnnotationId);
                    table.ForeignKey(
                        name: "FK_AnnotationScreenshots_Annotations_AnnotationId",
                        column: x => x.AnnotationId,
                        principalTable: "Annotations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AnnotationContexts");

            migrationBuilder.DropTable(
                name: "AnnotationScreenshots");
        }
    }
}
