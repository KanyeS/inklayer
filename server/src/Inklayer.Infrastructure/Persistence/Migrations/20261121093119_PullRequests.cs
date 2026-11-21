using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PullRequests : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "InSummary",
                table: "AnnotationIssues",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "PullRequest",
                table: "AnnotationIssues",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "Title",
                table: "AnnotationIssues",
                type: "TEXT",
                maxLength: 300,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "PullRequestSummaries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    ConnectionId = table.Column<Guid>(type: "TEXT", nullable: false),
                    PullRequestId = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    CommentExternalId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    PostedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    Origin = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    Body = table.Column<string>(type: "TEXT", maxLength: 60000, nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PullRequestSummaries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PullRequestSummaries_IssueTrackerConnections_ConnectionId",
                        column: x => x.ConnectionId,
                        principalTable: "IssueTrackerConnections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PullRequestSummaries_ConnectionId_PullRequestId",
                table: "PullRequestSummaries",
                columns: new[] { "ConnectionId", "PullRequestId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PullRequestSummaries");

            migrationBuilder.DropColumn(
                name: "InSummary",
                table: "AnnotationIssues");

            migrationBuilder.DropColumn(
                name: "PullRequest",
                table: "AnnotationIssues");

            migrationBuilder.DropColumn(
                name: "Title",
                table: "AnnotationIssues");
        }
    }
}
