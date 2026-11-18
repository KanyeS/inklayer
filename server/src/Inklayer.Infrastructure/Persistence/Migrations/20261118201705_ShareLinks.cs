using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ShareLinks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ShareLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    TokenHash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    ProtectedToken = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: false),
                    Kind = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    ProjectId = table.Column<Guid>(type: "TEXT", nullable: true),
                    PageUrl = table.Column<string>(type: "TEXT", maxLength: 2048, nullable: true),
                    DocId = table.Column<Guid>(type: "TEXT", nullable: true),
                    IncludeResolved = table.Column<bool>(type: "INTEGER", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    RevokedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    RevokedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ViewCount = table.Column<int>(type: "INTEGER", nullable: false),
                    LastViewedAt = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ShareLinks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ShareLinks_Docs_DocId",
                        column: x => x.DocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ShareLinks_Organizations_OrganizationId",
                        column: x => x.OrganizationId,
                        principalTable: "Organizations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ShareLinks_Projects_ProjectId",
                        column: x => x.ProjectId,
                        principalTable: "Projects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_ShareLinks_DocId",
                table: "ShareLinks",
                column: "DocId");

            migrationBuilder.CreateIndex(
                name: "IX_ShareLinks_OrganizationId",
                table: "ShareLinks",
                column: "OrganizationId");

            migrationBuilder.CreateIndex(
                name: "IX_ShareLinks_ProjectId",
                table: "ShareLinks",
                column: "ProjectId");

            migrationBuilder.CreateIndex(
                name: "IX_ShareLinks_TokenHash",
                table: "ShareLinks",
                column: "TokenHash",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ShareLinks");
        }
    }
}
