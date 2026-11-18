using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PreferredNames : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PreferredName",
                table: "Users",
                type: "TEXT",
                maxLength: 80,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PreferredName",
                table: "Users");
        }
    }
}
