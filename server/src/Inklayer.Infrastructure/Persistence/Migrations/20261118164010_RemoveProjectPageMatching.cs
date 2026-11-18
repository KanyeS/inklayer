using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Page matching moves from a project setting to each comment: the commenter chooses whether the query string and
    /// #hash are part of its address. Existing comments keep the keys they were stored under; a page finds comments under
    /// any form of its address, so they still show.
    /// </summary>
    public partial class RemoveProjectPageMatching : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LiveMatchHash",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "LiveMatchQuery",
                table: "Projects");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "LiveMatchHash",
                table: "Projects",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "LiveMatchQuery",
                table: "Projects",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);
        }
    }
}
