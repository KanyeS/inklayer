using System.Text.RegularExpressions;
using AngleSharp.Dom;
using AngleSharp.Html.Dom;
using AngleSharp.Html.Parser;

namespace Inklayer.Infrastructure.Snapshots;

/// <summary>
/// Removes active content from captured HTML before it is stored. This is the second line of defence. The first is the
/// snapshot origin's Content-Security-Policy (<c>script-src 'none'</c>, sandbox, no external loads), which stops script
/// even if something gets past this sanitizer.
/// <list type="bullet">
/// <item>Removes scripts, frames, plugins, <c>&lt;base&gt;</c>, <c>&lt;link&gt;</c>, <c>&lt;meta http-equiv&gt;</c> and <c>&lt;noscript&gt;</c>.</item>
/// <item>Removes every <c>on*</c> event-handler attribute, plus <c>srcdoc</c> and <c>srcset</c>.</item>
/// <item>Keeps URL attributes only if they point to <c>a/&lt;sha256&gt;</c> snapshot assets, image <c>data:</c> URLs, <c>#fragments</c>, or http(s) links on anchors.</item>
/// <item>Sanitizes declarative shadow DOM (<c>&lt;template shadowrootmode&gt;</c>) the same way.</item>
/// </list>
/// CSS is kept as captured, so the copy looks faithful. The CSP blocks any external fetch it could attempt.
/// </summary>
public static partial class SnapshotSanitizer
{
    private static readonly HashSet<string> RemovedElements = new(StringComparer.OrdinalIgnoreCase)
    {
        "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "portal",
        "base", "link", "fencedframe", "param",
    };

    private static readonly HashSet<string> UrlAttributes = new(StringComparer.OrdinalIgnoreCase)
    {
        "href", "xlink:href", "src", "action", "formaction", "poster", "background", "data", "cite", "longdesc",
        "ping", "manifest", "codebase", "lowsrc", "dynsrc", "itemtype", "profile",
    };

    private static readonly HashSet<string> RemovedAttributes = new(StringComparer.OrdinalIgnoreCase)
    {
        "srcdoc", "srcset", "imagesrcset", "nonce", "integrity", "http-equiv",
    };

    public static string Sanitize(string html)
    {
        var parser = new HtmlParser(new HtmlParserOptions { IsKeepingSourceReferences = false });
        using var document = parser.ParseDocument(html);

        // AngleSharp attaches declarative shadow roots and then omits them from serialization. Turn them back into
        // <template shadowrootmode> elements, so their content is kept and goes through the same sanitizing rules.
        RestoreDeclarativeShadowRoots(document, document.DocumentElement);
        SanitizeTree(document.DocumentElement);

        // Pin the encoding and stop the snapshot origin from leaking a referrer.
        var head = document.Head!;
        foreach (var meta in head.QuerySelectorAll("meta[charset], meta[name='referrer']").ToList())
        {
            meta.Remove();
        }

        var referrer = document.CreateElement("meta");
        referrer.SetAttribute("name", "referrer");
        referrer.SetAttribute("content", "no-referrer");
        head.Prepend(referrer);
        var charset = document.CreateElement("meta");
        charset.SetAttribute("charset", "utf-8");
        head.Prepend(charset);

        return "<!DOCTYPE html>\n" + document.DocumentElement.OuterHtml;
    }

    private static void RestoreDeclarativeShadowRoots(IDocument document, IParentNode root)
    {
        var elements = root.QuerySelectorAll("*").ToList();
        if (root is IElement rootElement)
        {
            elements.Insert(0, rootElement);
        }

        foreach (var element in elements)
        {
            if (element.ShadowRoot is not { } shadow)
            {
                continue;
            }

            RestoreDeclarativeShadowRoots(document, shadow);
            var template = (IHtmlTemplateElement)document.CreateElement("template");
            template.SetAttribute("shadowrootmode", "open");
            foreach (var child in shadow.ChildNodes.ToList())
            {
                template.Content.AppendChild(child);
            }

            element.Prepend(template);
        }
    }

    private static void SanitizeTree(IElement root)
    {
        // Snapshot the list first: removing nodes while iterating a live collection skips elements.
        var elements = new List<IElement> { root };
        elements.AddRange(root.QuerySelectorAll("*"));

        foreach (var element in elements)
        {
            if (element.Parent is null && element != root)
            {
                continue; // already removed with an ancestor
            }

            if (IsRemoved(element))
            {
                element.Remove();
                continue;
            }

            SanitizeAttributes(element);

            if (element is IHtmlTemplateElement template)
            {
                foreach (var child in template.Content.Children.ToList())
                {
                    if (IsRemoved(child))
                    {
                        child.Remove();
                    }
                    else
                    {
                        SanitizeTree(child);
                    }
                }
            }
        }
    }

    private static bool IsRemoved(IElement element)
    {
        var name = element.LocalName;
        if (RemovedElements.Contains(name))
        {
            return true;
        }

        if (name.Equals("meta", StringComparison.OrdinalIgnoreCase) && element.HasAttribute("http-equiv"))
        {
            return true;
        }

        // SVG animation can rewrite href/xlink:href to a javascript: URL at runtime.
        if (name is "set" or "animate" or "animateTransform" or "animateMotion")
        {
            var target = element.GetAttribute("attributeName") ?? "";
            return target.Contains("href", StringComparison.OrdinalIgnoreCase);
        }

        return false;
    }

    private static void SanitizeAttributes(IElement element)
    {
        foreach (var attribute in element.Attributes.ToList())
        {
            var name = attribute.Name;
            if (name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || RemovedAttributes.Contains(name))
            {
                element.RemoveAttribute(attribute.NamespaceUri, attribute.LocalName);
                continue;
            }

            if ((UrlAttributes.Contains(name) || attribute.LocalName.Equals("href", StringComparison.OrdinalIgnoreCase))
                && !IsAllowedUrl(element.LocalName, attribute.LocalName, attribute.Value))
            {
                element.RemoveAttribute(attribute.NamespaceUri, attribute.LocalName);
            }
        }
    }

    internal static bool IsAllowedUrl(string elementName, string attributeName, string value)
    {
        // Browsers ignore whitespace and control characters inside schemes ("jav\tascript:"), so check without them.
        var compact = ControlOrWhitespace().Replace(value, "").ToLowerInvariant();

        if (compact.Length == 0 || compact.StartsWith('#'))
        {
            return true;
        }

        if (AssetReference().IsMatch(compact))
        {
            return true;
        }

        // Inline images, including SVG: an image context never runs script, and the sandbox CSP would block it anyway.
        if (compact.StartsWith("data:image/", StringComparison.Ordinal))
        {
            return !attributeName.Equals("href", StringComparison.OrdinalIgnoreCase) || !elementName.Equals("a", StringComparison.OrdinalIgnoreCase);
        }

        // Ordinary links stay readable (the snapshot is a record of the page), but can't run anything.
        var isAnchor = elementName.Equals("a", StringComparison.OrdinalIgnoreCase) || elementName.Equals("area", StringComparison.OrdinalIgnoreCase);
        return isAnchor
            && attributeName.Equals("href", StringComparison.OrdinalIgnoreCase)
            && (compact.StartsWith("https://", StringComparison.Ordinal) || compact.StartsWith("http://", StringComparison.Ordinal) || compact.StartsWith("mailto:", StringComparison.Ordinal));
    }

    [GeneratedRegex(@"[\s\x00-\x1f\x7f]+")]
    private static partial Regex ControlOrWhitespace();

    [GeneratedRegex("^a/[0-9a-f]{64}(#[^\"'<>]*)?$")]
    private static partial Regex AssetReference();
}
