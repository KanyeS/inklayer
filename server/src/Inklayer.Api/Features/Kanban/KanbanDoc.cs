using System.Globalization;
using System.Text;
using Inklayer.Domain.Docs;
using YDotNet.Document.Cells;

namespace Inklayer.Api.Features.Kanban;

/// <summary>
/// A kanban's Yjs document, as the server reads and changes it. The browser's side is client/apps/viewer/src/kanban/kanbanModel.ts:
/// the two must agree on these names.
/// <list type="bullet">
/// <item><c>columns</c>: column id → map of <c>name</c>, <c>category</c> (todo, doing, done), <c>rank</c>, optional <c>wip</c>.</item>
/// <item><c>tasks</c>: task id → map of <c>key</c>, <c>title</c>, <c>description</c> (a Y.Text of markdown), <c>column</c>,
/// <c>rank</c>, <c>type</c>, <c>priority</c>, <c>assignees</c> and <c>tags</c> (plain lists of strings), and optional <c>reporter</c>,
/// <c>due</c> and <c>start</c> (yyyy-mm-dd), <c>estimate</c>, <c>parent</c>, <c>docId</c>, <c>extId</c>, <c>extKey</c>, <c>extUrl</c>,
/// <c>createdAt</c>, <c>createdBy</c>, <c>updatedAt</c> (ISO times).</item>
/// <item><c>relations</c>: relation id → map of <c>from</c>, <c>to</c> (task ids) and <c>type</c> (blocks, relates, duplicates, clones).</item>
/// </list>
/// Order within a column is by <c>rank</c>, a string compared ordinally (see <see cref="Ranks"/>), then by id.
/// </summary>
internal static class KanbanDoc
{
    public static readonly string[] Types = ["task", "bug", "story", "epic"];
    public static readonly string[] Priorities = ["highest", "high", "medium", "low", "lowest"];
    public static readonly string[] RelationTypes = ["blocks", "relates", "duplicates", "clones"];

    public sealed record Column(string Id, string Name, string Category, string Rank, double? Wip);

    public sealed class Task
    {
        public required string Id { get; init; }

        public string Key { get; set; } = "";

        public string Title { get; set; } = "";

        public string Description { get; set; } = "";

        public string Column { get; set; } = "";

        public string Rank { get; set; } = "";

        public string Type { get; set; } = "task";

        public string Priority { get; set; } = "medium";

        public List<string> Assignees { get; set; } = [];

        public List<string> Tags { get; set; } = [];

        public string? Reporter { get; set; }

        public string? Due { get; set; }

        public string? Start { get; set; }

        public double? Estimate { get; set; }

        public string? Parent { get; set; }

        public string? DocId { get; set; }

        public string? ExtId { get; set; }

        public string? ExtKey { get; set; }

        public string? ExtUrl { get; set; }

        public string? CreatedAt { get; set; }

        public string? CreatedBy { get; set; }

        public string? UpdatedAt { get; set; }

        public DateOnly? DueDate => DateOnly.TryParseExact(Due, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;

        public IEnumerable<Guid> AssigneeIds => Assignees.Select(a => Guid.TryParse(a, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty);
    }

    public sealed record Relation(string Id, string From, string To, string Type);

    public sealed record State(List<Column> Columns, Dictionary<string, Task> Tasks, List<Relation> Relations)
    {
        public Column? ColumnOf(Task task) => Columns.FirstOrDefault(c => c.Id == task.Column) ?? Columns.FirstOrDefault();

        /// <summary>Tasks in board order: column by column, then by rank.</summary>
        public IEnumerable<Task> Ordered() =>
            Tasks.Values.OrderBy(t => Columns.FindIndex(c => c.Id == t.Column) is var i && i < 0 ? int.MaxValue : i)
                .ThenBy(t => t.Rank, StringComparer.Ordinal).ThenBy(t => t.Id, StringComparer.Ordinal);
    }

    /* ------------------------------------------------------------------ reading */

    public static State Read(YDotNet.Document.Doc ydoc)
    {
        var columns = new List<Column>();
        var tasks = new Dictionary<string, Task>(StringComparer.Ordinal);
        var relations = new List<Relation>();
        var columnsMap = ydoc.Map("columns");
        var tasksMap = ydoc.Map("tasks");
        var relationsMap = ydoc.Map("relations");
        using var read = ydoc.ReadTransaction();
        foreach (var (id, value) in columnsMap.Iterate(read))
        {
            if (value.Tag != OutputTag.Map)
            {
                continue;
            }

            var map = value.Map;
            var category = Str(map.Get(read, "category"));
            columns.Add(new Column(id, Str(map.Get(read, "name")) ?? "Column", KanbanCategories.IsValid(category) ? category! : KanbanCategories.Todo,
                Str(map.Get(read, "rank")) ?? "", Num(map.Get(read, "wip"))));
        }

        columns.Sort((a, b) => string.CompareOrdinal(a.Rank, b.Rank) is var c and not 0 ? c : string.CompareOrdinal(a.Id, b.Id));

        foreach (var (id, value) in tasksMap.Iterate(read))
        {
            if (value.Tag != OutputTag.Map)
            {
                continue;
            }

            var map = value.Map;
            var description = map.Get(read, "description");
            tasks[id] = new Task
            {
                Id = id,
                Key = Str(map.Get(read, "key")) ?? "",
                Title = Str(map.Get(read, "title")) ?? "",
                Description = description?.Tag == OutputTag.Text ? description.Text.String(read) : Str(description) ?? "",
                Column = Str(map.Get(read, "column")) ?? "",
                Rank = Str(map.Get(read, "rank")) ?? "",
                Type = Str(map.Get(read, "type")) is { } type && Types.Contains(type) ? type : "task",
                Priority = Str(map.Get(read, "priority")) is { } priority && Priorities.Contains(priority) ? priority : "medium",
                Assignees = Strings(map.Get(read, "assignees")),
                Tags = Strings(map.Get(read, "tags")),
                Reporter = Str(map.Get(read, "reporter")),
                Due = Str(map.Get(read, "due")),
                Start = Str(map.Get(read, "start")),
                Estimate = Num(map.Get(read, "estimate")),
                Parent = Str(map.Get(read, "parent")),
                DocId = Str(map.Get(read, "docId")),
                ExtId = Str(map.Get(read, "extId")),
                ExtKey = Str(map.Get(read, "extKey")),
                ExtUrl = Str(map.Get(read, "extUrl")),
                CreatedAt = Str(map.Get(read, "createdAt")),
                CreatedBy = Str(map.Get(read, "createdBy")),
                UpdatedAt = Str(map.Get(read, "updatedAt")),
            };
        }

        foreach (var (id, value) in relationsMap.Iterate(read))
        {
            if (value.Tag == OutputTag.Map && Str(value.Map.Get(read, "from")) is { } from && Str(value.Map.Get(read, "to")) is { } to
                && Str(value.Map.Get(read, "type")) is { } type && RelationTypes.Contains(type))
            {
                relations.Add(new Relation(id, from, to, type));
            }
        }

        // A parent that's gone: the task stands on its own.
        foreach (var task in tasks.Values.Where(t => t.Parent is { } p && !tasks.ContainsKey(p)))
        {
            task.Parent = null;
        }

        relations.RemoveAll(r => !tasks.ContainsKey(r.From) || !tasks.ContainsKey(r.To));
        return new State(columns, tasks, relations);
    }

    private static double? Num(Output? o) => o?.Tag switch
    {
        OutputTag.Double => o.Double,
        OutputTag.Long => o.Long,
        _ => null,
    };

    private static string? Str(Output? o) => o?.Tag == OutputTag.String ? o.String : null;

    private static List<string> Strings(Output? o) =>
        o?.Tag switch
        {
            OutputTag.JsonArray => [.. o.JsonArray.Select(Str).OfType<string>()],
            OutputTag.String => [o.String],
            _ => [],
        };

    /* ------------------------------------------------------------------ changing */

    /// <summary>Columns a new kanban starts with, written by whoever opens it first (the browser does the same).</summary>
    public static readonly (string Name, string Category)[] DefaultColumns =
        [("To do", KanbanCategories.Todo), ("In progress", KanbanCategories.Doing), ("Done", KanbanCategories.Done)];

    /// <summary>A new kanban's Yjs state: the default columns, so no two people opening it at once each add their own.</summary>
    public static byte[] InitialState()
    {
        using var ydoc = new YDotNet.Document.Doc(new YDotNet.Document.Options.DocOptions { Encoding = YDotNet.Document.Options.DocEncoding.Utf16 });
        EnsureColumns(ydoc, Read(ydoc));
        using var read = ydoc.ReadTransaction();
        return read.StateDiffV1(null!);
    }

    /// <summary>Adds the default columns if the kanban has none. Returns them.</summary>
    public static List<Column> EnsureColumns(YDotNet.Document.Doc ydoc, State state)
    {
        if (state.Columns.Count > 0)
        {
            return state.Columns;
        }

        var map = ydoc.Map("columns");
        using var write = ydoc.WriteTransaction();
        string? rank = null;
        foreach (var (name, category) in DefaultColumns)
        {
            rank = Ranks.Between(rank, null);
            var column = new Column(Guid.NewGuid().ToString(), name, category, rank, null);
            map.Insert(write, column.Id, Input.Map(new Dictionary<string, Input>
            {
                ["name"] = Input.String(column.Name), ["category"] = Input.String(column.Category), ["rank"] = Input.String(column.Rank),
            }));
            state.Columns.Add(column);
        }

        write.Commit();
        return state.Columns;
    }

    public static void AddColumn(YDotNet.Document.Doc ydoc, Column column)
    {
        var map = ydoc.Map("columns");
        using var write = ydoc.WriteTransaction();
        map.Insert(write, column.Id, Input.Map(new Dictionary<string, Input>
        {
            ["name"] = Input.String(column.Name), ["category"] = Input.String(column.Category), ["rank"] = Input.String(column.Rank),
        }));
        write.Commit();
    }

    /// <summary>Writes a new task. <paramref name="task"/>'s fields are written as they are.</summary>
    public static void Insert(YDotNet.Document.Doc ydoc, Task task)
    {
        var map = ydoc.Map("tasks");
        using var write = ydoc.WriteTransaction();
        var fields = new Dictionary<string, Input>
        {
            ["key"] = Input.String(task.Key), ["title"] = Input.String(task.Title), ["description"] = Input.Text(task.Description),
            ["column"] = Input.String(task.Column), ["rank"] = Input.String(task.Rank), ["type"] = Input.String(task.Type),
            ["priority"] = Input.String(task.Priority), ["assignees"] = List(task.Assignees), ["tags"] = List(task.Tags),
        };
        foreach (var (name, value) in OptionalFields(task))
        {
            if (value is not null)
            {
                fields[name] = value;
            }
        }

        map.Insert(write, task.Id, Input.Map(fields));
        write.Commit();
    }

    /// <summary>Writes <paramref name="fields"/> of an existing task from <paramref name="task"/>. Fields set to null are removed.</summary>
    public static void Update(YDotNet.Document.Doc ydoc, Task task, IEnumerable<string> fields)
    {
        var tasks = ydoc.Map("tasks");
        using var write = ydoc.WriteTransaction();
        if (tasks.Get(write, task.Id) is not { Tag: OutputTag.Map } existing)
        {
            return;
        }

        var map = existing.Map;
        var optional = OptionalFields(task).ToDictionary(f => f.Name, f => f.Value);
        foreach (var field in fields.Distinct(StringComparer.Ordinal))
        {
            switch (field)
            {
                case "description":
                    if (map.Get(write, "description") is { Tag: OutputTag.Text } text)
                    {
                        var length = (uint)text.Text.String(write).Length;
                        if (length > 0)
                        {
                            text.Text.RemoveRange(write, 0, length);
                        }

                        text.Text.Insert(write, 0, task.Description);
                    }
                    else
                    {
                        map.Insert(write, "description", Input.Text(task.Description));
                    }

                    break;
                case "key": map.Insert(write, field, Input.String(task.Key)); break;
                case "title": map.Insert(write, field, Input.String(task.Title)); break;
                case "column": map.Insert(write, field, Input.String(task.Column)); break;
                case "rank": map.Insert(write, field, Input.String(task.Rank)); break;
                case "type": map.Insert(write, field, Input.String(task.Type)); break;
                case "priority": map.Insert(write, field, Input.String(task.Priority)); break;
                case "assignees": map.Insert(write, field, List(task.Assignees)); break;
                case "tags": map.Insert(write, field, List(task.Tags)); break;
                default:
                    if (optional.TryGetValue(field, out var value) && value is not null)
                    {
                        map.Insert(write, field, value);
                    }
                    else if (optional.ContainsKey(field))
                    {
                        map.Remove(write, field);
                    }

                    break;
            }
        }

        write.Commit();
    }

    public static void Remove(YDotNet.Document.Doc ydoc, State state, string taskId)
    {
        var tasks = ydoc.Map("tasks");
        var relations = ydoc.Map("relations");
        using var write = ydoc.WriteTransaction();
        tasks.Remove(write, taskId);
        foreach (var relation in state.Relations.Where(r => r.From == taskId || r.To == taskId))
        {
            relations.Remove(write, relation.Id);
        }

        // Its sub-tasks stay, on their own.
        foreach (var child in state.Tasks.Values.Where(t => t.Parent == taskId))
        {
            if (tasks.Get(write, child.Id) is { Tag: OutputTag.Map } map)
            {
                map.Map.Remove(write, "parent");
            }
        }

        write.Commit();
    }

    public static void AddRelation(YDotNet.Document.Doc ydoc, Relation relation)
    {
        var relations = ydoc.Map("relations");
        using var write = ydoc.WriteTransaction();
        relations.Insert(write, relation.Id, Input.Map(new Dictionary<string, Input>
        {
            ["from"] = Input.String(relation.From), ["to"] = Input.String(relation.To), ["type"] = Input.String(relation.Type),
        }));
        write.Commit();
    }

    public static void RemoveRelation(YDotNet.Document.Doc ydoc, string relationId)
    {
        var relations = ydoc.Map("relations");
        using var write = ydoc.WriteTransaction();
        relations.Remove(write, relationId);
        write.Commit();
    }

    private static Input List(IEnumerable<string> values) => Input.Collection([.. values.Select(Input.String)]);

    private static IEnumerable<(string Name, Input? Value)> OptionalFields(Task task)
    {
        static Input? S(string? value) => value is null ? null : Input.String(value);
        yield return ("reporter", S(task.Reporter));
        yield return ("due", S(task.Due));
        yield return ("start", S(task.Start));
        yield return ("estimate", task.Estimate is { } e ? Input.Double(e) : null);
        yield return ("parent", S(task.Parent));
        yield return ("docId", S(task.DocId));
        yield return ("extId", S(task.ExtId));
        yield return ("extKey", S(task.ExtKey));
        yield return ("extUrl", S(task.ExtUrl));
        yield return ("createdAt", S(task.CreatedAt));
        yield return ("createdBy", S(task.CreatedBy));
        yield return ("updatedAt", S(task.UpdatedAt));
    }

    /* ------------------------------------------------------------------ the summary */

    /// <summary>
    /// The markdown saved with each snapshot, for search, links, tags and backlinks. The browser writes the same
    /// (kanbanModel.ts summaryMarkdown): a heading per column, a line per task with its key, title and #tags, its linked doc as a
    /// [[link]], and its description indented below.
    /// </summary>
    /// <param name="docTitles">Titles of the docs tasks link, by id, written as [[links]] (others are left out).</param>
    public static string Summary(State state, IReadOnlyDictionary<Guid, string> docTitles)
    {
        var text = new StringBuilder();
        foreach (var column in state.Columns)
        {
            text.Append("## ").Append(column.Name).Append("\n\n");
            foreach (var task in state.Ordered().Where(t => state.ColumnOf(t)?.Id == column.Id))
            {
                text.Append("- ").Append(task.Key).Append(' ').Append(OneLine(task.Title));
                foreach (var tag in task.Tags)
                {
                    text.Append(" #").Append(tag);
                }

                if (task.Due is { } due)
                {
                    text.Append(" (due ").Append(due).Append(')');
                }

                if (Guid.TryParse(task.DocId, out var docId) && docTitles.TryGetValue(docId, out var title))
                {
                    text.Append(" [[").Append(title).Append("]]");
                }

                text.Append('\n');
                foreach (var line in task.Description.Split('\n').Where(l => l.Trim().Length > 0))
                {
                    text.Append("  ").Append(line.TrimEnd()).Append('\n');
                }
            }

            text.Append('\n');
        }

        return text.ToString().TrimEnd() + "\n";
    }

    private static string OneLine(string text) => text.ReplaceLineEndings(" ").Trim();
}

/// <summary>
/// Fractional ranks: strings of 0-9a-z, compared ordinally, where there's always room for another between two. Never end in
/// 0, so a rank can always be made before any other. The browser's copy is kanban/ranks.ts.
/// </summary>
internal static class Ranks
{
    private const string Digits = "0123456789abcdefghijklmnopqrstuvwxyz";

    /// <summary>A rank after <paramref name="before"/> (null: the start) and before <paramref name="after"/> (null: the end).</summary>
    public static string Between(string? before, string? after)
    {
        var a = before ?? "";
        var b = after;
        if (b is not null && string.CompareOrdinal(a, b) >= 0)
        {
            b = null; // out of order (two people moved at once): just go after
        }

        var result = new StringBuilder();
        for (var i = 0; ; i++)
        {
            var low = i < a.Length ? Digits.IndexOf(a[i], StringComparison.Ordinal) : 0;
            var high = b is not null && i < b.Length ? Digits.IndexOf(b[i], StringComparison.Ordinal) : Digits.Length;
            low = Math.Max(low, 0);
            if (high < 0)
            {
                high = Digits.Length;
            }

            if (low == high)
            {
                result.Append(Digits[low]);
                continue;
            }

            var mid = (low + high) / 2;
            if (mid > low)
            {
                return result.Append(Digits[mid]).ToString();
            }

            // Next to each other: keep the lower digit, and anything after it is below the upper bound.
            result.Append(Digits[low]);
            b = null;
        }
    }
}
