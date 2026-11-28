using System.ComponentModel;
using System.Text.RegularExpressions;
using Inklayer.Api.Access;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using YDotNet.Document.Cells;

namespace Inklayer.Api.Features.Docs;

/// <summary>A card on a board, as the AI tools see it. Positions are on the board (or inside the column, when it's in one).</summary>
public sealed record BoardCardInfo(
    string Id, string Type, double X, double Y, double W, double H, string? Column = null, string? Color = null,
    Guid? DocId = null, string? DocTitle = null, string? DocFolder = null, string? Text = null, string? Url = null, string? Title = null,
    string? Description = null);

/// <summary>An arrow someone drew between two cards.</summary>
public sealed record BoardArrowInfo(string Id, string From, string To, string? Label = null);

/// <summary>An arrow the board draws by itself, because one doc on it links another with [[...]].</summary>
public sealed record BoardLinkInfo(string From, string To);

public sealed record BoardInfo(
    Guid Id, Guid OrganizationId, string Folder, string Title, bool CanEdit, IReadOnlyList<BoardCardInfo> Cards, IReadOnlyList<BoardArrowInfo> Arrows,
    IReadOnlyList<BoardLinkInfo> DocLinks);

/// <summary>One change to a board, for the edit_board tool.</summary>
public sealed record BoardOperation(
    [property: Description("add_doc, add_note, add_link, add_column, move, update, remove or connect")] string Op,
    [property: Description("For add_*: a name of your choosing for the new card, so later operations in this call can use it as an id")] string? Ref = null,
    [property: Description("move, update, remove: the card's (or, for update and remove, an arrow's) id or ref")] string? Id = null,
    [property: Description("add_doc: the doc's id, title, or Folder/Title")] string? Doc = null,
    [property: Description("add_note, update: the note's text (plain text; [[Doc title]] links a doc)")] string? Text = null,
    [property: Description("add_link: the web address")] string? Url = null,
    [property: Description("add_column, add_link, update: the column's or link's title")] string? Title = null,
    [property: Description("add_link: a description to show (read from the page if left out)")] string? Description = null,
    [property: Description("add_*, update: a note's colour, #rrggbb (notes default to pale yellow)")] string? Color = null,
    [property: Description("add_*, move, connect: the column's id or ref to put the card in; move with \"\" takes it out")] string? Column = null,
    [property: Description("add_*, move: left edge on the board. Leave x and y out to have cards laid out tidily")] double? X = null,
    [property: Description("add_*, move: top edge on the board")] double? Y = null,
    [property: Description("add_*, move: width")] double? W = null,
    [property: Description("add_*, move: height (notes, docs and links grow with their content)")] double? H = null,
    [property: Description("connect: the card the arrow starts at (id or ref)")] string? From = null,
    [property: Description("connect: the card the arrow points to (id or ref)")] string? To = null,
    [property: Description("connect, update: the arrow's label; update with \"\" clears it")] string? Label = null);

/// <summary>What edit_board did: the new cards' ids by the refs given, and the board afterwards.</summary>
public sealed record BoardEditResult(IReadOnlyDictionary<string, string> Created, IReadOnlyList<string> Notes, BoardInfo Board);

/// <summary>
/// Reads and changes boards on the server, for the AI tools. A board's cards and arrows are Yjs maps (the shape is the
/// browser's, boards/boardModel.ts); the change is made like <see cref="DocText"/> makes text edits, so people with the board
/// open see it at once, and its summary (the docs on it as links, its notes' text) is written afresh for links and search.
/// </summary>
internal sealed partial class BoardEditor(InklayerDbContext db, DocText docText, DocIndexer indexer, LinkPreviewer previewer, CurrentUser currentUser)
{
    public const int MaxOperations = 200;
    public const int MaxCards = 500;
    private const double ColumnGap = 12;
    private const double ColumnHeader = 44;
    private const double LayoutGap = 40;
    private const string DefaultNoteColor = "#fef3c7";

    private static readonly Dictionary<string, (double W, double H)> Sizes = new(StringComparer.Ordinal)
    {
        ["doc"] = (280, 180), ["note"] = (220, 120), ["image"] = (260, 200), ["link"] = (280, 120), ["column"] = (300, 400),
    };

    /// <summary>A card while it's being changed. <see cref="Changed"/> lists the fields to write.</summary>
    private sealed class CardState
    {
        public required string Id { get; init; }

        public required string Type { get; init; }

        public double X { get; set; }

        public double Y { get; set; }

        public double W { get; set; }

        public double H { get; set; }

        public double Z { get; set; }

        public string? Parent { get; set; }

        public string? Color { get; set; }

        public Guid? DocId { get; set; }

        public string? Text { get; set; }

        public string? Url { get; set; }

        public string? Title { get; set; }

        public string? Description { get; set; }

        public string? Image { get; set; }

        public string? Alt { get; set; }

        public bool IsNew { get; init; }

        public HashSet<string> Changed { get; } = new(StringComparer.Ordinal);

        public void Set(string field, Action apply)
        {
            apply();
            Changed.Add(field);
        }
    }

    private sealed record ArrowState(string Id, string From, string To, string? Label, string? Color)
    {
        public bool IsNew { get; init; }

        public bool LabelChanged { get; init; }
    }

    /* ------------------------------------------------------------------ reading */

    public async Task<BoardInfo?> ReadAsync(Guid boardId, bool canEdit, CancellationToken ct)
    {
        var board = await db.Docs.AsNoTracking().Where(d => d.Id == boardId && d.DeletedAt == null && d.Kind == DocKinds.Board)
            .Select(d => new { d.Id, d.OrganizationId, d.Folder, d.Title, d.State, d.SnapshotSeq }).SingleOrDefaultAsync(ct);
        if (board is null)
        {
            return null;
        }

        var updates = await db.DocUpdates.AsNoTracking().Where(u => u.DocId == boardId && u.Seq > board.SnapshotSeq).OrderBy(u => u.Seq)
            .Select(u => u.Bytes).ToListAsync(ct);
        using var ydoc = DocText.Load(board.State, updates);
        var (cards, arrows) = Read(ydoc);
        return await DescribeAsync(board.Id, board.OrganizationId, board.Folder, board.Title, canEdit, cards, arrows, ct);
    }

    private async Task<BoardInfo> DescribeAsync(
        Guid id, Guid orgId, string folder, string title, bool canEdit, Dictionary<string, CardState> cards, List<ArrowState> arrows, CancellationToken ct)
    {
        var docs = await DocsAsync(cards.Values.Select(c => c.DocId).OfType<Guid>(), ct);
        var cardOfDoc = cards.Values.Where(c => c.DocId is { } d && docs.ContainsKey(d)).GroupBy(c => c.DocId!.Value).ToDictionary(g => g.Key, g => g.First().Id);
        var docIds = cardOfDoc.Keys.ToList();
        var links = docIds.Count == 0 ? [] : await db.DocLinks.AsNoTracking()
            .Where(l => l.SourceDocId != null && l.TargetDocId != null && docIds.Contains(l.SourceDocId.Value) && docIds.Contains(l.TargetDocId.Value)
                && l.SourceDocId != l.TargetDocId)
            .Select(l => new { Source = l.SourceDocId!.Value, Target = l.TargetDocId!.Value }).Distinct().ToListAsync(ct);

        var described = cards.Values
            .OrderBy(c => c.Type == "column" ? 0 : 1).ThenBy(c => Absolute(c, cards).Y).ThenBy(c => Absolute(c, cards).X)
            .Select(c =>
            {
                (Guid OrganizationId, string Folder, string Title) doc = default;
                var known = c.DocId is { } d && docs.TryGetValue(d, out doc);
                var title = known ? doc.Title : c.DocId is null ? null : "(deleted, or you can't open it)";
                return new BoardCardInfo(
                    c.Id, c.Type, c.X, c.Y, c.W, c.H, c.Parent, c.Color, c.DocId, title, known ? doc.Folder : null, c.Text, c.Url, c.Title ?? c.Alt,
                    c.Description);
            })
            .ToList();
        return new BoardInfo(
            id, orgId, folder, title, canEdit, described, [.. arrows.Select(a => new BoardArrowInfo(a.Id, a.From, a.To, a.Label))],
            [.. links.Select(l => new BoardLinkInfo(cardOfDoc[l.Source], cardOfDoc[l.Target]))]);
    }

    /// <summary>The docs among <paramref name="ids"/> the caller can open.</summary>
    private async Task<Dictionary<Guid, (Guid OrganizationId, string Folder, string Title)>> DocsAsync(IEnumerable<Guid> ids, CancellationToken ct)
    {
        var list = ids.Distinct().ToList();
        var visible = await DocAccess.VisibleAsync(db, currentUser.Id!.Value, list, ct);
        return await db.Docs.AsNoTracking().Where(d => visible.Contains(d.Id) && d.DeletedAt == null)
            .ToDictionaryAsync(d => d.Id, d => (d.OrganizationId, d.Folder, d.Title), ct);
    }

    private static (Dictionary<string, CardState> Cards, List<ArrowState> Arrows) Read(YDotNet.Document.Doc ydoc)
    {
        var cards = new Dictionary<string, CardState>(StringComparer.Ordinal);
        var arrows = new List<ArrowState>();
        var cardsMap = ydoc.Map("cards");
        var arrowsMap = ydoc.Map("arrows");
        using var read = ydoc.ReadTransaction();
        foreach (var (id, value) in cardsMap.Iterate(read))
        {
            if (value.Tag != OutputTag.Map)
            {
                continue;
            }

            var map = value.Map;
            var type = Str(map.Get(read, "type"));
            if (type is null || !Sizes.TryGetValue(type, out var size))
            {
                continue;
            }

            var text = map.Get(read, "text");
            cards[id] = new CardState
            {
                Id = id, Type = type,
                X = Num(map.Get(read, "x")) ?? 0, Y = Num(map.Get(read, "y")) ?? 0,
                W = Num(map.Get(read, "w")) ?? size.W, H = Num(map.Get(read, "h")) ?? size.H, Z = Num(map.Get(read, "z")) ?? 0,
                Parent = Str(map.Get(read, "parent")), Color = Str(map.Get(read, "color")),
                DocId = Guid.TryParse(Str(map.Get(read, "docId")), out var docId) ? docId : null,
                Text = text?.Tag == OutputTag.Text ? text.Text.String(read) : null,
                Url = Str(map.Get(read, "url")), Title = Str(map.Get(read, "title")), Description = Str(map.Get(read, "description")),
                Image = Str(map.Get(read, "image")), Alt = Str(map.Get(read, "alt")),
            };
        }

        foreach (var (id, value) in arrowsMap.Iterate(read))
        {
            if (value.Tag == OutputTag.Map && Str(value.Map.Get(read, "from")) is { } from && Str(value.Map.Get(read, "to")) is { } to)
            {
                arrows.Add(new ArrowState(id, from, to, Str(value.Map.Get(read, "label")), Str(value.Map.Get(read, "color"))));
            }
        }

        // Cards in a column that's gone count as on the board.
        foreach (var card in cards.Values.Where(c => c.Parent is { } p && !cards.ContainsKey(p)))
        {
            card.Parent = null;
        }

        return (cards, arrows);
    }

    private static double? Num(Output? o) => o?.Tag switch
    {
        OutputTag.Double => o.Double,
        OutputTag.Long => o.Long,
        _ => null,
    };

    private static string? Str(Output? o) => o?.Tag == OutputTag.String ? o.String : null;

    private static (double X, double Y) Absolute(CardState card, Dictionary<string, CardState> cards) =>
        card.Parent is { } p && cards.TryGetValue(p, out var column) ? (card.X + column.X, card.Y + column.Y) : (card.X, card.Y);

    /* ------------------------------------------------------------------ changing */

    /// <summary>Applies <paramref name="operations"/> in order, as one change. Throws <see cref="InvalidOperationException"/> to refuse.</summary>
    public async Task<BoardEditResult?> EditAsync(Guid boardId, IReadOnlyList<BoardOperation> operations, CancellationToken ct)
    {
        if (operations.Count == 0 || operations.Count > MaxOperations)
        {
            throw new InvalidOperationException($"Send between 1 and {MaxOperations} operations.");
        }

        var board = await db.Docs.AsNoTracking().Where(d => d.Id == boardId && d.DeletedAt == null)
            .Select(d => new { d.Id, d.OrganizationId, d.Folder, d.Title, d.Kind }).SingleOrDefaultAsync(ct);
        if (board is null)
        {
            return null;
        }

        if (board.Kind != DocKinds.Board)
        {
            throw new InvalidOperationException("That's a doc, not a board. Use edit_doc for docs.");
        }

        // Looked up first (the change itself is made in one go): the docs to add, and what the links' pages say.
        var docsToAdd = await ResolveDocsAsync(board.OrganizationId, operations.Where(o => o.Op == "add_doc").Select(o => o.Doc ?? ""), ct);
        var previews = new Dictionary<string, LinkPreviewResponse>(StringComparer.Ordinal);
        foreach (var op in operations.Where(o => o.Op == "add_link" && o.Title is null && Uri.TryCreate(o.Url, UriKind.Absolute, out _)))
        {
            var uri = new Uri(op.Url!);
            if (uri.Scheme is "http" or "https" && !previews.ContainsKey(op.Url!))
            {
                previews[op.Url!] = await previewer.PreviewAsync(uri, ct);
            }
        }

        var created = new Dictionary<string, string>(StringComparer.Ordinal);
        var notes = new List<string>();
        Dictionary<string, CardState>? finalCards = null;
        List<ArrowState>? finalArrows = null;
        var result = await docText.ChangeAsync(boardId, currentUser.Id!.Value, DocKinds.Board, async (ydoc, storedSummary) =>
        {
            var (cards, arrows) = Read(ydoc);
            var removedCards = new HashSet<string>(StringComparer.Ordinal);
            var removedArrows = new HashSet<string>(StringComparer.Ordinal);
            var restack = new HashSet<string>(StringComparer.Ordinal);
            var layout = new AutoLayout(cards);
            var z = cards.Values.Select(c => c.Z).DefaultIfEmpty(0).Max();

            string Resolve(string? idOrRef, string what) =>
                idOrRef is null ? throw new InvalidOperationException($"Say which {what}.")
                : created.TryGetValue(idOrRef, out var id) ? id
                : cards.ContainsKey(idOrRef) || arrows.Any(a => a.Id == idOrRef) ? idOrRef
                : throw new InvalidOperationException($"There's no card or arrow \"{idOrRef}\" on the board.");

            string? ColumnOf(string? idOrRef) =>
                string.IsNullOrEmpty(idOrRef) ? null
                : cards.GetValueOrDefault(Resolve(idOrRef, "column")) is { Type: "column" } column ? column.Id
                : throw new InvalidOperationException($"\"{idOrRef}\" isn't a column.");

            CardState Add(BoardOperation op, string type, Action<CardState> fill)
            {
                if (cards.Count >= MaxCards)
                {
                    throw new InvalidOperationException($"A board can have at most {MaxCards} cards.");
                }

                var size = Sizes[type];
                var card = new CardState { Id = Guid.NewGuid().ToString(), Type = type, IsNew = true, W = op.W ?? size.W, H = op.H ?? size.H, Z = ++z };
                fill(card);
                var column = type == "column" ? null : ColumnOf(op.Column);
                if (column is not null)
                {
                    card.Parent = column;
                    card.Y = double.MaxValue / 4; // after the column's cards; stacked below
                    restack.Add(column);
                }
                else if (op.X is { } x && op.Y is { } y)
                {
                    (card.X, card.Y) = (x, y);
                }
                else
                {
                    (card.X, card.Y) = layout.Next(card);
                }

                cards[card.Id] = card;
                if (op.Ref is { Length: > 0 } name)
                {
                    created[name] = card.Id;
                }

                return card;
            }

            foreach (var op in operations)
            {
                switch (op.Op)
                {
                    case "add_doc":
                    {
                        if (!docsToAdd.TryGetValue(op.Doc ?? "", out var docId))
                        {
                            throw new InvalidOperationException($"There's no doc \"{op.Doc}\" that you can open. Use list_docs or search_docs to find it.");
                        }

                        if (cards.Values.FirstOrDefault(c => c.DocId == docId) is { } existing)
                        {
                            notes.Add($"\"{op.Doc}\" was already on the board ({existing.Id}).");
                            if (op.Ref is { Length: > 0 } name)
                            {
                                created[name] = existing.Id;
                            }

                            break;
                        }

                        Add(op, "doc", c => c.DocId = docId);
                        break;
                    }

                    case "add_note":
                        Add(op, "note", c => (c.Text, c.Color) = (Clip(op.Text, 5000) ?? "", Color(op.Color) ?? DefaultNoteColor));
                        break;

                    case "add_link":
                    {
                        if (!Uri.TryCreate(op.Url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
                        {
                            throw new InvalidOperationException("add_link needs an http or https url.");
                        }

                        var preview = previews.GetValueOrDefault(op.Url!);
                        Add(op, "link", c =>
                        {
                            c.Url = preview?.Url ?? uri.AbsoluteUri;
                            c.Title = Clip(op.Title ?? preview?.Title, 300);
                            c.Description = Clip(op.Description ?? preview?.Description, 600);
                            c.Image = preview?.Image;
                        });
                        break;
                    }

                    case "add_column":
                        Add(op, "column", c => c.Title = Clip(op.Title, 200) ?? "Column");
                        break;

                    case "move":
                    {
                        var card = cards[Resolve(op.Id, "card")];
                        if (op.Column is not null && card.Type != "column")
                        {
                            var column = ColumnOf(op.Column);
                            if (column != card.Parent)
                            {
                                var (ax, ay) = Absolute(card, cards);
                                if (card.Parent is { } left)
                                {
                                    restack.Add(left);
                                }

                                card.Set("parent", () => card.Parent = column);
                                if (column is null)
                                {
                                    var size = Sizes[card.Type];
                                    card.Set("x", () => card.X = op.X ?? ax);
                                    card.Set("y", () => card.Y = op.Y ?? ay);
                                    card.Set("w", () => card.W = size.W);
                                }
                                else
                                {
                                    card.Set("y", () => card.Y = op.Y is { } oy ? oy - cards[column].Y : double.MaxValue / 4);
                                    restack.Add(column);
                                }
                            }
                        }
                        else
                        {
                            if (op.X is { } x)
                            {
                                card.Set("x", () => card.X = card.Parent is { } p ? x - cards[p].X : x);
                            }

                            if (op.Y is { } y)
                            {
                                card.Set("y", () => card.Y = card.Parent is { } p ? y - cards[p].Y : y);
                            }

                            if (card.Parent is { } parent && op.Y is not null)
                            {
                                restack.Add(parent);
                            }
                        }

                        if (op.W is { } w)
                        {
                            card.Set("w", () => card.W = Math.Clamp(w, 80, 4000));
                        }

                        if (op.H is { } h)
                        {
                            card.Set("h", () => card.H = Math.Clamp(h, 40, 4000));
                        }

                        break;
                    }

                    case "update":
                    {
                        var id = Resolve(op.Id, "card or arrow");
                        if (cards.TryGetValue(id, out var card))
                        {
                            if (op.Text is not null && card.Type == "note")
                            {
                                card.Set("text", () => card.Text = Clip(op.Text, 5000));
                            }

                            if (op.Title is not null && card.Type is "column" or "link")
                            {
                                card.Set("title", () => card.Title = Clip(op.Title, card.Type == "column" ? 200 : 300));
                            }

                            if (op.Color is not null)
                            {
                                card.Set("color", () => card.Color = Color(op.Color));
                            }
                        }
                        else if (op.Label is not null)
                        {
                            var index = arrows.FindIndex(a => a.Id == id);
                            arrows[index] = arrows[index] with { Label = op.Label.Length == 0 ? null : Clip(op.Label, 200), LabelChanged = true };
                        }

                        break;
                    }

                    case "remove":
                    {
                        var id = Resolve(op.Id, "card or arrow");
                        if (cards.Remove(id, out var card))
                        {
                            removedCards.Add(id);
                            foreach (var child in cards.Values.Where(c => c.Parent == id))
                            {
                                child.Set("x", () => child.X += card.X);
                                child.Set("y", () => child.Y += card.Y);
                                child.Set("parent", () => child.Parent = null);
                            }

                            if (card.Parent is { } parent)
                            {
                                restack.Add(parent);
                            }

                            foreach (var arrow in arrows.Where(a => a.From == id || a.To == id).ToList())
                            {
                                arrows.Remove(arrow);
                                removedArrows.Add(arrow.Id);
                            }
                        }
                        else
                        {
                            arrows.RemoveAll(a => a.Id == id);
                            removedArrows.Add(id);
                        }

                        break;
                    }

                    case "connect":
                    {
                        var from = Resolve(op.From, "card the arrow starts at");
                        var to = Resolve(op.To, "card the arrow points to");
                        if (!cards.ContainsKey(from) || !cards.ContainsKey(to) || from == to)
                        {
                            throw new InvalidOperationException("Arrows go between two different cards.");
                        }

                        if (arrows.Any(a => (a.From == from && a.To == to) || (a.From == to && a.To == from)))
                        {
                            notes.Add($"There's already an arrow between {from} and {to}.");
                            break;
                        }

                        var arrow = new ArrowState(Guid.NewGuid().ToString(), from, to, Clip(op.Label, 200), null) { IsNew = true };
                        arrows.Add(arrow);
                        if (op.Ref is { Length: > 0 } name)
                        {
                            created[name] = arrow.Id;
                        }

                        break;
                    }

                    default:
                        throw new InvalidOperationException($"Unknown operation \"{op.Op}\".");
                }
            }

            foreach (var column in restack.Where(cards.ContainsKey))
            {
                Stack(column, cards);
            }

            Write(ydoc, cards, arrows, removedCards, removedArrows);
            finalCards = cards;
            finalArrows = arrows;
            return (storedSummary, await SummaryAsync(board.OrganizationId, cards, arrows, ct));
        }, ct);

        if (result is null)
        {
            return null;
        }

        var info = await DescribeAsync(board.Id, board.OrganizationId, board.Folder, board.Title, true, finalCards ?? [], finalArrows ?? [], ct);
        return new BoardEditResult(created, notes, info);
    }

    /// <summary>The docs named (by id, title or Folder/Title) that the caller can open: ids may be other organisations' shared docs.</summary>
    private async Task<Dictionary<string, Guid>> ResolveDocsAsync(Guid orgId, IEnumerable<string> names, CancellationToken ct)
    {
        var all = names.Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).ToList();
        var byId = all.Where(n => Guid.TryParse(n, out _)).ToDictionary(n => n, Guid.Parse);
        var keys = all.Where(n => !byId.ContainsKey(n)).ToDictionary(n => n, n => n.Trim().TrimStart('[').TrimEnd(']').ToLowerInvariant());
        var resolved = keys.Count == 0 ? [] : await indexer.ResolveAsync(orgId, [.. keys.Values.Distinct()], ct);
        var wanted = byId.Values.Concat(resolved.Values.OfType<Guid>()).Distinct().ToList();
        var visible = await DocAccess.VisibleAsync(db, currentUser.Id!.Value, wanted, ct);
        var live = await db.Docs.AsNoTracking().Where(d => visible.Contains(d.Id) && d.DeletedAt == null).Select(d => d.Id).ToListAsync(ct);
        var found = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var (name, id) in byId.Where(x => live.Contains(x.Value)))
        {
            found[name] = id;
        }

        foreach (var (name, key) in keys)
        {
            if (resolved.GetValueOrDefault(key) is { } id && live.Contains(id))
            {
                found[name] = id;
            }
        }

        return found;
    }

    /// <summary>Stacks a column's cards top to bottom in their order, as wide as the column, and makes it tall enough.</summary>
    private static void Stack(string columnId, Dictionary<string, CardState> cards)
    {
        var column = cards[columnId];
        var y = ColumnHeader;
        foreach (var child in cards.Values.Where(c => c.Parent == columnId).OrderBy(c => c.Y).ThenBy(c => c.X).ToList())
        {
            var top = y;
            if (child.X != ColumnGap)
            {
                child.Set("x", () => child.X = ColumnGap);
            }

            if (child.Y != top)
            {
                child.Set("y", () => child.Y = top);
            }

            if (child.W != column.W - (2 * ColumnGap))
            {
                child.Set("w", () => child.W = column.W - (2 * ColumnGap));
            }

            y += child.H + ColumnGap;
        }

        var height = Math.Max(Sizes["column"].H, y + ColumnGap);
        if (column.H != height)
        {
            column.Set("h", () => column.H = height);
        }
    }

    /// <summary>Places new cards with no position given: columns side by side to the right of what's there, then other cards in rows below them.</summary>
    private sealed class AutoLayout
    {
        private const int PerRow = 4;
        private readonly double _left;
        private readonly double _top;
        private double _columnX;
        private int _placed;
        private double _rowTop;
        private double _rowHeight;
        private bool _anyColumns;

        public AutoLayout(Dictionary<string, CardState> cards)
        {
            var top = cards.Values.Where(c => c.Parent is null).ToList();
            _left = top.Count == 0 ? 0 : top.Max(c => c.X + c.W) + (LayoutGap * 2);
            _top = top.Count == 0 ? 0 : top.Min(c => c.Y);
            _columnX = _left;
            _rowTop = _top;
        }

        public (double X, double Y) Next(CardState card)
        {
            if (card.Type == "column")
            {
                var at = (_columnX, _top);
                _columnX += card.W + LayoutGap;
                if (!_anyColumns)
                {
                    _anyColumns = true;
                    _rowTop = _top + Sizes["column"].H + (LayoutGap * 2);
                }

                return at;
            }

            if (_placed > 0 && _placed % PerRow == 0)
            {
                _rowTop += _rowHeight + LayoutGap;
                _rowHeight = 0;
            }

            var x = _left + (_placed % PerRow * (Sizes["doc"].W + LayoutGap));
            _placed++;
            _rowHeight = Math.Max(_rowHeight, card.H);
            return (x, _rowTop);
        }
    }

    private static void Write(
        YDotNet.Document.Doc ydoc, Dictionary<string, CardState> cards, List<ArrowState> arrows, HashSet<string> removedCards, HashSet<string> removedArrows)
    {
        var cardsMap = ydoc.Map("cards");
        var arrowsMap = ydoc.Map("arrows");
        using var write = ydoc.WriteTransaction();
        foreach (var id in removedCards)
        {
            cardsMap.Remove(write, id);
        }

        foreach (var id in removedArrows)
        {
            arrowsMap.Remove(write, id);
        }

        foreach (var card in cards.Values)
        {
            if (card.IsNew)
            {
                cardsMap.Insert(write, card.Id, Input.Map(NewCard(card)));
                continue;
            }

            if (card.Changed.Count == 0 || cardsMap.Get(write, card.Id) is not { Tag: OutputTag.Map } existing)
            {
                continue;
            }

            var map = existing.Map;
            foreach (var field in card.Changed)
            {
                if (field == "text")
                {
                    if (map.Get(write, "text") is { Tag: OutputTag.Text } text)
                    {
                        var length = (uint)text.Text.String(write).Length;
                        if (length > 0)
                        {
                            text.Text.RemoveRange(write, 0, length);
                        }

                        text.Text.Insert(write, 0, card.Text ?? "");
                    }

                    continue;
                }

                if (Field(card, field) is { } value)
                {
                    map.Insert(write, field, value);
                }
                else
                {
                    map.Remove(write, field);
                }
            }
        }

        foreach (var arrow in arrows)
        {
            if (arrow.IsNew)
            {
                var fields = new Dictionary<string, Input> { ["from"] = Input.String(arrow.From), ["to"] = Input.String(arrow.To) };
                if (arrow.Label is { } label)
                {
                    fields["label"] = Input.String(label);
                }

                arrowsMap.Insert(write, arrow.Id, Input.Map(fields));
            }
            else if (arrow.LabelChanged && arrowsMap.Get(write, arrow.Id) is { Tag: OutputTag.Map } existing)
            {
                if (arrow.Label is { } label)
                {
                    existing.Map.Insert(write, "label", Input.String(label));
                }
                else
                {
                    existing.Map.Remove(write, "label");
                }
            }
        }

        write.Commit();
    }

    /// <summary>A field's value for Yjs. Numbers are always doubles: the browser reads them as plain numbers.</summary>
    private static Input? Field(CardState card, string field) => field switch
    {
        "x" => Input.Double(Math.Round(card.X)),
        "y" => Input.Double(Math.Round(card.Y)),
        "w" => Input.Double(Math.Round(card.W)),
        "h" => Input.Double(Math.Round(card.H)),
        "z" => Input.Double(card.Z),
        "parent" => card.Parent is { } p ? Input.String(p) : null,
        "color" => card.Color is { } c ? Input.String(c) : null,
        "title" => card.Title is { } t ? Input.String(t) : null,
        _ => null,
    };

    private static Dictionary<string, Input> NewCard(CardState card)
    {
        var fields = new Dictionary<string, Input>
        {
            ["type"] = Input.String(card.Type),
            ["x"] = Input.Double(Math.Round(card.X)), ["y"] = Input.Double(Math.Round(card.Y)),
            ["w"] = Input.Double(Math.Round(card.W)), ["h"] = Input.Double(Math.Round(card.H)), ["z"] = Input.Double(card.Z),
        };
        void Optional(string key, string? value)
        {
            if (value is not null)
            {
                fields[key] = Input.String(value);
            }
        }

        Optional("parent", card.Parent);
        Optional("color", card.Color);
        Optional("docId", card.DocId?.ToString());
        Optional("url", card.Url);
        Optional("title", card.Title);
        Optional("description", card.Description);
        Optional("image", card.Image);
        if (card.Type == "note")
        {
            fields["text"] = Input.Text(card.Text ?? "");
        }

        return fields;
    }

    /// <summary>The summary the browser writes too (boards/boardModel.ts summaryMarkdown): linked docs, then notes, columns, links and labels.</summary>
    private async Task<string> SummaryAsync(Guid orgId, Dictionary<string, CardState> cards, List<ArrowState> arrows, CancellationToken ct)
    {
        var ids = cards.Values.Select(c => c.DocId).OfType<Guid>().Distinct().ToList();
        var titles = await db.Docs.AsNoTracking().Where(d => ids.Contains(d.Id) && d.OrganizationId == orgId && d.DeletedAt == null)
            .ToDictionaryAsync(d => d.Id, d => d.Folder.Length > 0 ? $"{d.Folder}/{d.Title}" : d.Title, ct);
        var links = new List<string>();
        var text = new List<string>();
        foreach (var card in cards.Values.OrderBy(c => Absolute(c, cards).Y).ThenBy(c => Absolute(c, cards).X))
        {
            switch (card.Type)
            {
                case "doc" when card.DocId is { } id && titles.TryGetValue(id, out var path):
                    links.Add($"- [[{path}]]");
                    break;
                case "note" when !string.IsNullOrWhiteSpace(card.Text):
                    text.Add(card.Text.Trim());
                    break;
                case "column" when !string.IsNullOrWhiteSpace(card.Title):
                    text.Add($"## {card.Title.Trim()}");
                    break;
                case "link":
                    text.Add($"[{SquareBrackets().Replace(card.Title ?? card.Url ?? "", "")}]({card.Url})");
                    break;
                case "image" when !string.IsNullOrWhiteSpace(card.Alt):
                    text.Add(card.Alt);
                    break;
            }
        }

        text.AddRange(arrows.Where(a => !string.IsNullOrWhiteSpace(a.Label)).Select(a => a.Label!.Trim()));
        var parts = new List<string>();
        if (links.Count > 0)
        {
            parts.Add(string.Join('\n', links));
        }

        parts.AddRange(text);
        return string.Join("\n\n", parts);
    }

    private static string? Clip(string? value, int max) =>
        value is null ? null : value.Length > max ? value[..max] : value;

    private static string? Color(string? color) =>
        color is not null && HexColor().IsMatch(color) ? color.ToLowerInvariant() : null;

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex HexColor();

    [GeneratedRegex(@"[\[\]]")]
    private static partial Regex SquareBrackets();
}
