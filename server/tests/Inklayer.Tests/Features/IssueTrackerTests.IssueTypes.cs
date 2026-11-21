using System.Net;
using System.Text;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record IssueTypesDto(List<string> Types, string? Suggested);

/// <summary>The issue types a project offers, for the tracker form's dropdown.</summary>
public sealed partial class IssueTrackerTests
{
    [Fact]
    public async Task Azure_DevOps_lists_the_projects_work_item_types_without_hidden_ones()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Org = "https://dev.azure.com/types-basic";
        const string Project = $"{Org}/Shop";
        // The Basic process: no Bug. Test Case is hidden, Old Type disabled.
        factory.Outbound.Responders[$"{Project}/_apis/wit/workitemtypes?"] = (_, _) => Json(new
        {
            value = new object[]
            {
                new { name = "Epic", isDisabled = false }, new { name = "Issue", isDisabled = false }, new { name = "Task", isDisabled = false },
                new { name = "Test Case", isDisabled = false }, new { name = "Old Type", isDisabled = true },
            },
        });
        factory.Outbound.Responders[$"{Project}/_apis/wit/workitemtypecategories?"] = (_, _) => Json(new
        {
            value = new[]
            {
                new { referenceName = "Microsoft.RequirementCategory", workItemTypes = new[] { new { name = "Issue" } } },
                new { referenceName = "Microsoft.HiddenCategory", workItemTypes = new[] { new { name = "Test Case" } } },
            },
        });

        var url = $"/api/projects/{projectId}/issue-trackers/issue-types";
        using (var listed = await admin.PostJsonAsync(url, new { kind = "azuredevops", token = "ado-pat", settings = new { site = Org, projectKey = "Shop" } }))
        {
            var types = await listed.ReadAsync<IssueTypesDto>();
            Assert.Equal(["Epic", "Issue", "Task"], types.Types);
            Assert.Equal("Issue", types.Suggested); // No Bug here.
        }

        // The type already chosen stays chosen, whatever its case.
        using (var listed = await admin.PostJsonAsync(url, new { kind = "azuredevops", token = "ado-pat", settings = new { site = Org, projectKey = "Shop", issueType = "task" } }))
        {
            Assert.Equal("Task", (await listed.ReadAsync<IssueTypesDto>()).Suggested);
        }

        // Editing a saved tracker uses its token, which the form doesn't have.
        factory.Outbound.Responders[$"{Project}/_apis/wit/workitemtypes/Issue"] = (_, _) => Json(new { name = "Issue" });
        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "azuredevops", token = "saved-pat", settings = new { site = Org, projectKey = "Shop", issueType = "Issue" } });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        using (var listed = await admin.PostJsonAsync(url, new { kind = "azuredevops", connectionId = tracker.Id, settings = new { site = Org, projectKey = "Shop" } }))
        {
            Assert.Equal(3, (await listed.ReadAsync<IssueTypesDto>()).Types.Count);
        }

        var sentWith = factory.Outbound.To($"{Project}/_apis/wit/workitemtypes?").Last().Request.Headers.Authorization!.Parameter;
        Assert.Equal(Convert.ToBase64String(Encoding.UTF8.GetBytes(":saved-pat")), sentWith);

        // No token anywhere, a wrong project, and people who can't manage the project.
        using (var noToken = await admin.PostJsonAsync(url, new { kind = "azuredevops", settings = new { site = "https://tfs.acme.test/Collection", projectKey = "Shop" } }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, noToken.StatusCode);
        }

        factory.Outbound.Responders[$"{Org}/Nope/_apis/"] = (_, _) => Json(new { message = "VS800075: The project with id 'Nope' does not exist" }, HttpStatusCode.NotFound);
        using (var wrong = await admin.PostJsonAsync(url, new { kind = "azuredevops", token = "ado-pat", settings = new { site = Org, projectKey = "Nope" } }))
        {
            Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
            Assert.Contains("VS800075", await wrong.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        await ana.PostJsonAsync(url, new { kind = "azuredevops", token = "ado-pat", settings = new { site = Org, projectKey = "Shop" } }).ExpectAsync(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Jira_lists_the_projects_issue_types_without_sub_tasks_and_others_have_none()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Site = "https://types.atlassian.net";
        factory.Outbound.Responders[$"{Site}/rest/api/3/project/WEB"] = (_, _) => Json(new
        {
            key = "WEB",
            issueTypes = new object[]
            {
                new { name = "Task", subtask = false }, new { name = "Bug", subtask = false }, new { name = "Story", subtask = false }, new { name = "Subtask", subtask = true },
            },
        });

        var url = $"/api/projects/{projectId}/issue-trackers/issue-types";
        using (var listed = await admin.PostJsonAsync(url, new { kind = "jira", token = "api-token", settings = new { site = Site, projectKey = "WEB", email = "bot@acme.test" } }))
        {
            var types = await listed.ReadAsync<IssueTypesDto>();
            Assert.Equal(["Task", "Bug", "Story"], types.Types);
            Assert.Equal("Bug", types.Suggested);
        }

        using var github = await admin.PostJsonAsync(url, new { kind = "github", token = "ghp", settings = new { owner = "acme", repo = "shop" } });
        var none = await github.ReadAsync<IssueTypesDto>();
        Assert.Empty(none.Types);
        Assert.Null(none.Suggested);
    }

    [Fact]
    public async Task Commenters_choose_the_type_of_each_issue_from_the_types_they_can_use()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Org = "https://dev.azure.com/types-pick";
        const string Project = $"{Org}/Shop";
        var r = factory.Outbound.Responders;
        r[$"{Project}/_apis/wit/workitemtypes?"] = (_, _) => Json(new { value = new[] { new { name = "Epic" }, new { name = "Issue" }, new { name = "Task" } } });
        r[$"{Project}/_apis/wit/workitemtypecategories?"] = (_, _) => Json(new { value = Array.Empty<object>() });
        r[$"{Project}/_apis/wit/workitemtypes/Issue"] = (_, _) => Json(new { name = "Issue" });
        r[$"{Project}/_apis/wit/workitems/$"] = (_, _) => Json(new { id = 21 });

        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "azuredevops", token = "pat", settings = new { site = Org, projectKey = "Shop", issueType = "Issue" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);

        // A Commenter sees the project's types, starting on the tracker's own.
        using (var listed = await ana.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/issue-types", UriKind.Relative)))
        {
            var types = await listed.ReadAsync<IssueTypesDto>();
            Assert.Equal(["Epic", "Issue", "Task"], types.Types);
            Assert.Equal("Issue", types.Suggested);
        }

        await viewer.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/issue-types", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);

        // Created as the type chosen, spelled as the project spells it; the tracker's own when none is chosen.
        var comment = await CommentAsync(ana, projectId, "Checkout button is grey");
        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id, type = "task" }).ExpectAsync(HttpStatusCode.Created);
        Assert.Single(factory.Outbound.To($"{Project}/_apis/wit/workitems/$Task"));
        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        Assert.Single(factory.Outbound.To($"{Project}/_apis/wit/workitems/$Issue"));

        // A type the project doesn't have is refused before anything is created.
        using (var refused = await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id, type = "Bug" }))
        {
            Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
            Assert.Contains("no issue type called Bug", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        Assert.Empty(factory.Outbound.To($"{Project}/_apis/wit/workitems/$Bug"));
    }
}
