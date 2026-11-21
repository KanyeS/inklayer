using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class PageDetailsMore : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "IpCountry",
                table: "AnnotationContexts",
                type: "TEXT",
                maxLength: 100,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "IpNetwork",
                table: "AnnotationContexts",
                type: "TEXT",
                maxLength: 200,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "IpNetworkKind",
                table: "AnnotationContexts",
                type: "TEXT",
                maxLength: 16,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "Scripts",
                table: "AnnotationContexts",
                type: "TEXT",
                maxLength: 2000,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "TimeZone",
                table: "AnnotationContexts",
                type: "TEXT",
                maxLength: 64,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<int>(
                name: "UtcOffsetMinutes",
                table: "AnnotationContexts",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "IpCountry",
                table: "AnnotationContexts");

            migrationBuilder.DropColumn(
                name: "IpNetwork",
                table: "AnnotationContexts");

            migrationBuilder.DropColumn(
                name: "IpNetworkKind",
                table: "AnnotationContexts");

            migrationBuilder.DropColumn(
                name: "Scripts",
                table: "AnnotationContexts");

            migrationBuilder.DropColumn(
                name: "TimeZone",
                table: "AnnotationContexts");

            migrationBuilder.DropColumn(
                name: "UtcOffsetMinutes",
                table: "AnnotationContexts");
        }
    }
}
