using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DocUpdateSeq : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropPrimaryKey(
                name: "PK_DocUpdates",
                table: "DocUpdates");

            migrationBuilder.DropIndex(
                name: "IX_DocUpdates_DocId_Seq",
                table: "DocUpdates");

            migrationBuilder.AddColumn<long>(
                name: "LastSeq",
                table: "Docs",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AlterColumn<long>(
                name: "Seq",
                table: "DocUpdates",
                type: "INTEGER",
                nullable: false,
                oldClrType: typeof(long),
                oldType: "INTEGER")
                .OldAnnotation("Sqlite:Autoincrement", true);

            migrationBuilder.AddPrimaryKey(
                name: "PK_DocUpdates",
                table: "DocUpdates",
                columns: new[] { "DocId", "Seq" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropPrimaryKey(
                name: "PK_DocUpdates",
                table: "DocUpdates");

            migrationBuilder.DropColumn(
                name: "LastSeq",
                table: "Docs");

            migrationBuilder.AlterColumn<long>(
                name: "Seq",
                table: "DocUpdates",
                type: "INTEGER",
                nullable: false,
                oldClrType: typeof(long),
                oldType: "INTEGER")
                .Annotation("Sqlite:Autoincrement", true);

            migrationBuilder.AddPrimaryKey(
                name: "PK_DocUpdates",
                table: "DocUpdates",
                column: "Seq");

            migrationBuilder.CreateIndex(
                name: "IX_DocUpdates_DocId_Seq",
                table: "DocUpdates",
                columns: new[] { "DocId", "Seq" });
        }
    }
}
