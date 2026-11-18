using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class UserLogins : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "UserLogins",
                columns: table => new
                {
                    Provider = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    Subject = table.Column<string>(type: "TEXT", maxLength: 255, nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserLogins", x => new { x.Provider, x.Subject });
                    table.ForeignKey(
                        name: "FK_UserLogins_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserLogins_UserId_Provider",
                table: "UserLogins",
                columns: new[] { "UserId", "Provider" },
                unique: true);

            // Every existing user signed in with Google: carry their Google account over as a login.
            migrationBuilder.Sql("INSERT INTO UserLogins (Provider, Subject, UserId, CreatedAt) SELECT 'google', GoogleSubject, Id, CreatedAt FROM Users;");

            migrationBuilder.DropIndex(
                name: "IX_Users_GoogleSubject",
                table: "Users");

            migrationBuilder.DropColumn(
                name: "GoogleSubject",
                table: "Users");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "GoogleSubject",
                table: "Users",
                type: "TEXT",
                maxLength: 255,
                nullable: false,
                defaultValue: "");

            // Users without a Google login get a placeholder that can't match a real Google account, keeping the column unique.
            migrationBuilder.Sql("""
                UPDATE Users SET GoogleSubject = COALESCE(
                    (SELECT Subject FROM UserLogins WHERE UserLogins.UserId = Users.Id AND Provider = 'google'),
                    'no-google-login:' || Id);
                """);

            migrationBuilder.CreateIndex(
                name: "IX_Users_GoogleSubject",
                table: "Users",
                column: "GoogleSubject",
                unique: true);

            migrationBuilder.DropTable(
                name: "UserLogins");
        }
    }
}
