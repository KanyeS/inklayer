using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Inklayer.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class Kanban : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "TaskKey",
                table: "Notifications",
                type: "TEXT",
                maxLength: 32,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "KanbanBoards",
                columns: table => new
                {
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    KeyPrefix = table.Column<string>(type: "TEXT", maxLength: 10, nullable: false),
                    NextNumber = table.Column<long>(type: "INTEGER", nullable: false),
                    TrackerConnectionId = table.Column<Guid>(type: "TEXT", nullable: true),
                    StatusMap = table.Column<string>(type: "TEXT", nullable: true),
                    SyncDirection = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    SyncedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    SyncError = table.Column<string>(type: "TEXT", maxLength: 1000, nullable: true),
                    SyncVersion = table.Column<int>(type: "INTEGER", nullable: false),
                    ConnectedByUserId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ConnectedAt = table.Column<DateTime>(type: "TEXT", nullable: true),
                    PushExisting = table.Column<bool>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_KanbanBoards", x => x.DocId);
                    table.ForeignKey(
                        name: "FK_KanbanBoards_Docs_DocId",
                        column: x => x.DocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_KanbanBoards_IssueTrackerConnections_TrackerConnectionId",
                        column: x => x.TrackerConnectionId,
                        principalTable: "IssueTrackerConnections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "KanbanTasks",
                columns: table => new
                {
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    OrganizationId = table.Column<Guid>(type: "TEXT", nullable: false),
                    Key = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    Title = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    ColumnId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    ColumnName = table.Column<string>(type: "TEXT", maxLength: 200, nullable: false),
                    Category = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    Type = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    Priority = table.Column<string>(type: "TEXT", maxLength: 16, nullable: false),
                    Due = table.Column<DateOnly>(type: "TEXT", nullable: true),
                    ParentTaskId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    LinkedDocId = table.Column<Guid>(type: "TEXT", nullable: true),
                    ExternalId = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    ExternalKey = table.Column<string>(type: "TEXT", maxLength: 200, nullable: true),
                    ExternalUrl = table.Column<string>(type: "TEXT", maxLength: 2000, nullable: true),
                    SyncedFields = table.Column<string>(type: "TEXT", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "TEXT", nullable: false),
                    DueRemindedFor = table.Column<DateOnly>(type: "TEXT", nullable: true),
                    OverdueRemindedFor = table.Column<DateOnly>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_KanbanTasks", x => new { x.DocId, x.TaskId });
                    table.ForeignKey(
                        name: "FK_KanbanTasks_Docs_DocId",
                        column: x => x.DocId,
                        principalTable: "Docs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "KanbanTaskAssignees",
                columns: table => new
                {
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    UserId = table.Column<Guid>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_KanbanTaskAssignees", x => new { x.DocId, x.TaskId, x.UserId });
                    table.ForeignKey(
                        name: "FK_KanbanTaskAssignees_KanbanTasks_DocId_TaskId",
                        columns: x => new { x.DocId, x.TaskId },
                        principalTable: "KanbanTasks",
                        principalColumns: new[] { "DocId", "TaskId" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "KanbanTaskTags",
                columns: table => new
                {
                    DocId = table.Column<Guid>(type: "TEXT", nullable: false),
                    TaskId = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    Tag = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_KanbanTaskTags", x => new { x.DocId, x.TaskId, x.Tag });
                    table.ForeignKey(
                        name: "FK_KanbanTaskTags_KanbanTasks_DocId_TaskId",
                        columns: x => new { x.DocId, x.TaskId },
                        principalTable: "KanbanTasks",
                        principalColumns: new[] { "DocId", "TaskId" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_KanbanBoards_OrganizationId_KeyPrefix",
                table: "KanbanBoards",
                columns: new[] { "OrganizationId", "KeyPrefix" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_KanbanBoards_TrackerConnectionId",
                table: "KanbanBoards",
                column: "TrackerConnectionId");

            migrationBuilder.CreateIndex(
                name: "IX_KanbanTaskAssignees_UserId",
                table: "KanbanTaskAssignees",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_KanbanTaskTags_Tag",
                table: "KanbanTaskTags",
                column: "Tag");

            migrationBuilder.CreateIndex(
                name: "IX_KanbanTasks_LinkedDocId",
                table: "KanbanTasks",
                column: "LinkedDocId");

            migrationBuilder.CreateIndex(
                name: "IX_KanbanTasks_OrganizationId_Due",
                table: "KanbanTasks",
                columns: new[] { "OrganizationId", "Due" });

            migrationBuilder.CreateIndex(
                name: "IX_KanbanTasks_OrganizationId_Key",
                table: "KanbanTasks",
                columns: new[] { "OrganizationId", "Key" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "KanbanBoards");

            migrationBuilder.DropTable(
                name: "KanbanTaskAssignees");

            migrationBuilder.DropTable(
                name: "KanbanTaskTags");

            migrationBuilder.DropTable(
                name: "KanbanTasks");

            migrationBuilder.DropColumn(
                name: "TaskKey",
                table: "Notifications");
        }
    }
}
