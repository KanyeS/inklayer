using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class LiveMode : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Annotations_ProjectId",
                table: "Annotations");

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

            migrationBuilder.AddColumn<string>(
                name: "LiveSites",
                table: "Projects",
                type: "TEXT",
                nullable: false,
                defaultValue: "[]");

            migrationBuilder.AlterColumn<Guid>(
                name: "SnapshotId",
                table: "Annotations",
                type: "TEXT",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "TEXT");

            migrationBuilder.AddColumn<string>(
                name: "PageUrl",
                table: "Annotations",
                type: "TEXT",
                maxLength: 2048,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Annotations_ProjectId_PageUrl_CreatedAt",
                table: "Annotations",
                columns: new[] { "ProjectId", "PageUrl", "CreatedAt" });

            migrationBuilder.AddCheckConstraint(
                name: "CK_Annotations_SnapshotOrPage",
                table: "Annotations",
                sql: "(SnapshotId IS NULL) <> (PageUrl IS NULL)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Annotations_ProjectId_PageUrl_CreatedAt",
                table: "Annotations");

            migrationBuilder.DropCheckConstraint(
                name: "CK_Annotations_SnapshotOrPage",
                table: "Annotations");

            migrationBuilder.DropColumn(
                name: "LiveMatchHash",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "LiveMatchQuery",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "LiveSites",
                table: "Projects");

            migrationBuilder.DropColumn(
                name: "PageUrl",
                table: "Annotations");

            migrationBuilder.AlterColumn<Guid>(
                name: "SnapshotId",
                table: "Annotations",
                type: "TEXT",
                nullable: false,
                defaultValue: new Guid("00000000-0000-0000-0000-000000000000"),
                oldClrType: typeof(Guid),
                oldType: "TEXT",
                oldNullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Annotations_ProjectId",
                table: "Annotations",
                column: "ProjectId");
        }
    }
}
