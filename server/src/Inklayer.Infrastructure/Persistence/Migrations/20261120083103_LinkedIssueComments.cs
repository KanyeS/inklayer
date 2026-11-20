using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class LinkedIssueComments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AnnotationIssues_ConnectionId",
                table: "AnnotationIssues");

            migrationBuilder.AddColumn<bool>(
                name: "PostRepliesToIssue",
                table: "IssueTrackerConnections",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTime>(
                name: "ClosedAt",
                table: "AnnotationIssues",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "CommentsCheckedAt",
                table: "AnnotationIssues",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "Linked",
                table: "AnnotationIssues",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "IssueComments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConnectionId = table.Column<Guid>(type: "TEXT", nullable: false),
                    IssueExternalId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    ExternalId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    AuthorName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    AuthorUrl = table.Column<string>(type: "TEXT", maxLength: 500, nullable: true),
                    Body = table.Column<string>(type: "TEXT", maxLength: 20000, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    FromInklayer = table.Column<bool>(type: "INTEGER", nullable: false),
                    ReplyId = table.Column<Guid>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IssueComments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_IssueComments_IssueTrackerConnections_ConnectionId",
                        column: x => x.ConnectionId,
                        principalTable: "IssueTrackerConnections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AnnotationIssues_ConnectionId_ExternalId",
                table: "AnnotationIssues",
                columns: new[] { "ConnectionId", "ExternalId" });

            migrationBuilder.CreateIndex(
                name: "IX_IssueComments_ConnectionId_IssueExternalId_ExternalId",
                table: "IssueComments",
                columns: new[] { "ConnectionId", "IssueExternalId", "ExternalId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "IssueComments");

            migrationBuilder.DropIndex(
                name: "IX_AnnotationIssues_ConnectionId_ExternalId",
                table: "AnnotationIssues");

            migrationBuilder.DropColumn(
                name: "PostRepliesToIssue",
                table: "IssueTrackerConnections");

            migrationBuilder.DropColumn(
                name: "ClosedAt",
                table: "AnnotationIssues");

            migrationBuilder.DropColumn(
                name: "CommentsCheckedAt",
                table: "AnnotationIssues");

            migrationBuilder.DropColumn(
                name: "Linked",
                table: "AnnotationIssues");

            migrationBuilder.CreateIndex(
                name: "IX_AnnotationIssues_ConnectionId",
                table: "AnnotationIssues",
                column: "ConnectionId");
        }
    }
}
