using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Docs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Full-text search over docs (SQLite FTS5, part of the bundled SQLite). Kept up to date by DocIndexer.
            migrationBuilder.Sql(
                "CREATE VIRTUAL TABLE \"DocSearch\" USING fts5(\"DocId\" UNINDEXED, \"OrganizationId\" UNINDEXED, \"Title\", \"Content\", " +
                "tokenize = 'unicode61 remove_diacritics 2');");

            migrationBuilder.CreateTable(
                name: "DocFolders",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Path = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    PathKey = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocFolders", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocFolders_Organizations_OrganizationId",
                        column: x => x.OrganizationId,
                        principalTable: "Organizations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Docs",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Folder = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    PathKey = table.Column<string>(type: "TEXT", maxLength: 701, nullable: false),
                    TitleKey = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Content = table.Column<string>(type: "TEXT", maxLength: 1000000, nullable: false),
                    State = table.Column<byte[]>(type: "BLOB", nullable: true),
                    SnapshotSeq = table.Column<long>(type: "INTEGER", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedByUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    Version = table.Column<int>(type: "INTEGER", nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    LastRevisionAt = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Docs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Docs_Organizations_OrganizationId",
                        column: x => x.OrganizationId,
                        principalTable: "Organizations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DocLinks",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    SourceDocId = table.Column<Guid>(type: "TEXT", nullable: true),
                    SourceAnnotationId = table.Column<Guid>(type: "TEXT", nullable: true),
                    TargetDocId = table.Column<Guid>(type: "TEXT", nullable: true),
                    TargetAnnotationId = table.Column<Guid>(type: "TEXT", nullable: true),
                    TargetKey = table.Column<string>(type: "TEXT", maxLength: 701, nullable: false),
                    Text = table.Column<string>(type: "TEXT", maxLength: 701, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocLinks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocLinks_Annotations_SourceAnnotationId",
                        column: x => x.SourceAnnotationId,
                        principalTable: "Annotations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_DocLinks_Docs_SourceDocId",
                        column: x => x.SourceDocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_DocLinks_Docs_TargetDocId",
                        column: x => x.TargetDocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "DocRevisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Version = table.Column<int>(type: "INTEGER", nullable: false),
                    Action = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    ActorUserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    OccurredAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    Folder = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Content = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocRevisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DocRevisions_Docs_DocId",
                        column: x => x.DocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DocTags",
                columns: table => new
                {
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Tag = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocTags", x => new { x.DocId, x.Tag });
                    table.ForeignKey(
                        name: "FK_DocTags_Docs_DocId",
                        column: x => x.DocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "DocUpdates",
                columns: table => new
                {
                    Seq = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Bytes = table.Column<byte[]>(type: "BLOB", nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    At = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DocUpdates", x => x.Seq);
                    table.ForeignKey(
                        name: "FK_DocUpdates_Docs_DocId",
                        column: x => x.DocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DocFolders_OrganizationId_PathKey",
                table: "DocFolders",
                columns: new[] { "OrganizationId", "PathKey" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DocLinks_OrganizationId_TargetKey",
                table: "DocLinks",
                columns: new[] { "OrganizationId", "TargetKey" });

            migrationBuilder.CreateIndex(
                name: "IX_DocLinks_SourceAnnotationId",
                table: "DocLinks",
                column: "SourceAnnotationId");

            migrationBuilder.CreateIndex(
                name: "IX_DocLinks_SourceDocId",
                table: "DocLinks",
                column: "SourceDocId");

            migrationBuilder.CreateIndex(
                name: "IX_DocLinks_TargetAnnotationId",
                table: "DocLinks",
                column: "TargetAnnotationId");

            migrationBuilder.CreateIndex(
                name: "IX_DocLinks_TargetDocId",
                table: "DocLinks",
                column: "TargetDocId");

            migrationBuilder.CreateIndex(
                name: "IX_DocRevisions_DocId_Version",
                table: "DocRevisions",
                columns: new[] { "DocId", "Version" });

            migrationBuilder.CreateIndex(
                name: "IX_DocRevisions_OrganizationId_OccurredAt",
                table: "DocRevisions",
                columns: new[] { "OrganizationId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_DocTags_OrganizationId_Tag",
                table: "DocTags",
                columns: new[] { "OrganizationId", "Tag" });

            migrationBuilder.CreateIndex(
                name: "IX_DocUpdates_DocId_Seq",
                table: "DocUpdates",
                columns: new[] { "DocId", "Seq" });

            migrationBuilder.CreateIndex(
                name: "IX_Docs_OrganizationId_PathKey",
                table: "Docs",
                columns: new[] { "OrganizationId", "PathKey" },
                unique: true,
                filter: "\"DeletedAt\" IS NULL");

            migrationBuilder.CreateIndex(
                name: "IX_Docs_OrganizationId_TitleKey",
                table: "Docs",
                columns: new[] { "OrganizationId", "TitleKey" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP TABLE IF EXISTS \"DocSearch\";");

            migrationBuilder.DropTable(
                name: "DocFolders");

            migrationBuilder.DropTable(
                name: "DocLinks");

            migrationBuilder.DropTable(
                name: "DocRevisions");

            migrationBuilder.DropTable(
                name: "DocTags");

            migrationBuilder.DropTable(
                name: "DocUpdates");

            migrationBuilder.DropTable(
                name: "Docs");
        }
    }
}
