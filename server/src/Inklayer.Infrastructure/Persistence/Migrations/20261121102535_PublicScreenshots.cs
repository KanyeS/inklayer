using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PublicScreenshots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PublicToken",
                table: "AnnotationScreenshots",
                type: "TEXT",
                maxLength: 64,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_AnnotationScreenshots_PublicToken",
                table: "AnnotationScreenshots",
                column: "PublicToken",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AnnotationScreenshots_PublicToken",
                table: "AnnotationScreenshots");

            migrationBuilder.DropColumn(
                name: "PublicToken",
                table: "AnnotationScreenshots");
        }
    }
}
