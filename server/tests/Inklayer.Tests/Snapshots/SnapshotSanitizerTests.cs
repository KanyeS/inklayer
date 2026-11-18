using Inklayer.Infrastructure.Snapshots;

namespace Inklayer.Tests.Snapshots;

public sealed class SnapshotSanitizerTests
{
    private const string Asset = "a/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    public static TheoryData<string> XssPayloads => new()
    {
        "<script>alert(1)</script>",
        "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
        "<img src=x onerror=alert(1)>",
        "<img src=\"" + Asset + "\" ONERROR=\"alert(1)\">",
        "<body onload=alert(1)>",
        "<a href=\"javascript:alert(1)\">x</a>",
        "<a href=\"JaVaScRiPt:alert(1)\">x</a>",
        "<a href=\"jav&#x09;ascript:alert(1)\">x</a>",
        "<a href=\"  javascript:alert(1)\">x</a>",
        "<a href=\"vbscript:msgbox(1)\">x</a>",
        "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>",
        "<iframe src=\"javascript:alert(1)\"></iframe>",
        "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
        "<object data=\"javascript:alert(1)\"></object>",
        "<embed src=\"javascript:alert(1)\">",
        "<svg><script>alert(1)</script></svg>",
        "<svg onload=alert(1)></svg>",
        "<svg><a xlink:href=\"javascript:alert(1)\"><text>x</text></a></svg>",
        "<svg><a><animate attributeName=\"href\" values=\"javascript:alert(1)\"/><text>x</text></a></svg>",
        "<svg><set attributeName=\"xlink:href\" to=\"javascript:alert(1)\"/></svg>",
        "<math><mtext><script>alert(1)</script></mtext></math>",
        "<form action=\"javascript:alert(1)\"><button>x</button></form>",
        "<button formaction=\"javascript:alert(1)\">x</button>",
        "<meta http-equiv=\"refresh\" content=\"0;url=javascript:alert(1)\">",
        "<base href=\"javascript:alert(1)//\">",
        "<link rel=\"stylesheet\" href=\"https://evil.example/x.css\">",
        "<template><script>alert(1)</script></template>",
        "<div><template shadowrootmode=\"open\"><img src=x onerror=alert(1)><script>alert(1)</script></template></div>",
        "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\"></noscript>",
        "<details open ontoggle=alert(1)>",
        "<video poster=\"javascript:alert(1)\"></video>",
        "<isindex action=\"javascript:alert(1)\" type=image>",
    };

    [Theory]
    [MemberData(nameof(XssPayloads))]
    public void Removes_script_vectors(string payload)
    {
        var output = SnapshotSanitizer.Sanitize($"<html><head></head><body>{payload}</body></html>").ToLowerInvariant();

        Assert.DoesNotContain("<script", output, StringComparison.Ordinal);
        Assert.DoesNotContain("javascript:", output, StringComparison.Ordinal);
        Assert.DoesNotContain("vbscript:", output, StringComparison.Ordinal);
        Assert.DoesNotContain("onerror", output, StringComparison.Ordinal);
        Assert.DoesNotContain("onload", output, StringComparison.Ordinal);
        Assert.DoesNotContain("ontoggle", output, StringComparison.Ordinal);
        Assert.DoesNotContain("<iframe", output, StringComparison.Ordinal);
        Assert.DoesNotContain("<object", output, StringComparison.Ordinal);
        Assert.DoesNotContain("<embed", output, StringComparison.Ordinal);
        Assert.DoesNotContain("<base", output, StringComparison.Ordinal);
        Assert.DoesNotContain("<link", output, StringComparison.Ordinal);
        Assert.DoesNotContain("http-equiv", output, StringComparison.Ordinal);
        Assert.DoesNotContain("data:text/html", output, StringComparison.Ordinal);
    }

    [Fact]
    public void Keeps_the_page_content_styles_and_snapshot_assets()
    {
        var html = $$"""
            <html><head><title>Shop</title><style>.hero{background:url({{Asset}})} :root{--brand:#f00}</style></head>
            <body class="home"><h1 style="color:var(--brand)">Hello &amp; welcome</h1>
            <img src="{{Asset}}" alt="logo" width="10"><a href="https://example.com/about">About</a><a href="#top">Top</a>
            <input value="typed text" checked type="checkbox"><svg viewBox="0 0 10 10"><linearGradient id="g"/><use href="#g"/></svg>
            <div><template shadowrootmode="open"><style>p{color:red}</style><p>shadow</p></template></div></body></html>
            """;

        var output = SnapshotSanitizer.Sanitize(html);

        Assert.StartsWith("<!DOCTYPE html>", output, StringComparison.Ordinal);
        Assert.Contains("<title>Shop</title>", output, StringComparison.Ordinal);
        Assert.Contains($".hero{{background:url({Asset})}}", output, StringComparison.Ordinal);
        Assert.Contains("--brand:#f00", output, StringComparison.Ordinal);
        Assert.Contains("style=\"color:var(--brand)\"", output, StringComparison.Ordinal);
        Assert.Contains($"src=\"{Asset}\"", output, StringComparison.Ordinal);
        Assert.Contains("href=\"https://example.com/about\"", output, StringComparison.Ordinal);
        Assert.Contains("href=\"#top\"", output, StringComparison.Ordinal);
        Assert.Contains("value=\"typed text\"", output, StringComparison.Ordinal);
        Assert.Contains("viewBox=\"0 0 10 10\"", output, StringComparison.Ordinal);
        Assert.Contains("linearGradient", output, StringComparison.Ordinal);
        Assert.Contains("shadowrootmode=\"open\"", output, StringComparison.Ordinal);
        Assert.Contains("<p>shadow</p>", output, StringComparison.Ordinal);
        Assert.Contains("Hello &amp; welcome", output, StringComparison.Ordinal);
        Assert.Contains("<meta charset=\"utf-8\">", output, StringComparison.Ordinal);
        Assert.Contains("<meta name=\"referrer\" content=\"no-referrer\">", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("img", "src", "https://tracker.example/pixel.gif")]
    [InlineData("img", "src", "//tracker.example/pixel.gif")]
    [InlineData("img", "src", "a/../../api/me")]
    [InlineData("a", "href", "data:image/png;base64,AAAA")]
    [InlineData("a", "href", "file:///etc/passwd")]
    public void Strips_urls_that_are_not_snapshot_assets(string element, string attribute, string url)
    {
        var output = SnapshotSanitizer.Sanitize($"<html><body><{element} {attribute}=\"{url}\">x</{element}></body></html>");

        Assert.DoesNotContain(url, output, StringComparison.Ordinal);
    }

    [Fact]
    public void Removes_names_that_would_clobber_document_properties()
    {
        var output = SnapshotSanitizer.Sanitize(
            "<html><body><img name=\"querySelector\" src=\"data:image/png;base64,AA==\"><form name=\"createElement\"></form><input name=\"email\"></body></html>");

        Assert.DoesNotContain("querySelector", output, StringComparison.Ordinal);
        Assert.DoesNotContain("createElement", output, StringComparison.Ordinal);
        Assert.Contains("name=\"email\"", output, StringComparison.Ordinal); // inputs don't clobber document
    }

    [Fact]
    public void Allows_inline_image_data_urls()
    {
        var output = SnapshotSanitizer.Sanitize("<html><body><img src=\"data:image/png;base64,iVBORw0KGgo=\"></body></html>");

        Assert.Contains("data:image/png;base64,iVBORw0KGgo=", output, StringComparison.Ordinal);
    }
}
