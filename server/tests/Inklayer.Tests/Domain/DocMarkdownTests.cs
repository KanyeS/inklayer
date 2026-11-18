using Inklayer.Domain.Docs;

namespace Inklayer.Tests.Domain;

public sealed class DocMarkdownTests
{
    [Fact]
    public void Links_follow_obsidian_syntax()
    {
        var (links, _) = DocMarkdown.Extract("See [[Roadmap]], [[Research/Interviews|the interviews]], [[Launch plan#Risks]] and ![[Diagram]].");

        Assert.Equal(["Roadmap", "Research/Interviews", "Launch plan", "Diagram"], links.Select(l => l.Target));
        Assert.Equal("the interviews", links[1].Alias);
        Assert.Equal("research/interviews", links[1].Key);
        Assert.Equal("Risks", links[2].Heading);
        Assert.True(links[3].Embed);
    }

    [Fact]
    public void Comment_links_carry_the_comment_id()
    {
        var id = Guid.NewGuid();
        var link = Assert.Single(DocMarkdown.Links($"As discussed in [[comment:{id}]]"));
        Assert.Equal(id, link.CommentId);
        Assert.Null(link.Target);

        Assert.Empty(DocMarkdown.Links("[[comment:not-a-guid]]"));
    }

    [Fact]
    public void Code_is_not_parsed()
    {
        const string Markdown = "Before [[Real]]\n```\n[[Not a link]] #nottag\n```\nInline `[[No]] #no` and #yes";
        var (links, tags) = DocMarkdown.Extract(Markdown);

        Assert.Equal(["Real"], links.Select(l => l.Target));
        Assert.Equal(["yes"], tags);
    }

    [Theory]
    [InlineData("#idea and #Project/Alpha", new[] { "idea", "project/alpha" })]
    [InlineData("# Heading\n## Another", new string[0])]
    [InlineData("issue #123 page#anchor https://x.test/#frag", new string[0])]
    [InlineData("#2024-review", new[] { "2024-review" })]
    [InlineData("[[Doc#Heading]] #real", new[] { "real" })]
    public void Tags(string markdown, string[] expected)
    {
        Assert.Equal(expected, DocMarkdown.Extract(markdown).Tags);
    }

    [Theory]
    [InlineData("  Roadmap  ", "Roadmap", null)]
    [InlineData("", null, "A title is required.")]
    [InlineData("a/b", null, "Titles can't contain [ ] | # / \\ or ^.")]
    [InlineData("x[y]", null, "Titles can't contain [ ] | # / \\ or ^.")]
    public void Titles_are_checked(string input, string? expected, string? error)
    {
        Assert.Equal(expected, DocPaths.NormalizeTitle(input, out var actualError));
        Assert.Equal(error, actualError);
    }

    [Fact]
    public void Folders_are_normalised()
    {
        Assert.Equal("Research/Interviews", DocPaths.NormalizeFolder(" Research / Interviews/ ", out _));
        Assert.Equal("", DocPaths.NormalizeFolder("  ", out _));
        Assert.Null(DocPaths.NormalizeFolder("a/../b", out _));
        Assert.True(DocPaths.IsWithin("Research/Interviews", "research"));
        Assert.False(DocPaths.IsWithin("Researchers", "Research"));
    }
}
