using System.Net;
using Microsoft.AspNetCore.Antiforgery;
using OpenIddict.Abstractions;

namespace Inklayer.Api.Auth;

/// <summary>
/// "Allow this app to use Inklayer as you?" Shown once per app and person, after sign-in. The form posts the original
/// authorization request back with the answer, protected by an antiforgery token.
/// </summary>
internal static class ConsentPage
{
    /// <summary>
    /// The page's own CSP. Above all, no other site may frame it: a framed "Allow" button can be clickjacked.
    /// Its only style is inline, and its only form posts back here.
    /// </summary>
    internal const string Policy =
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

    public static string Render(HttpContext context, IAntiforgery antiforgery, OpenIddictRequest request, string appName, string userName, bool expired)
    {
        context.Response.Headers.ContentSecurityPolicy = Policy;
        context.Response.Headers.XFrameOptions = "DENY";

        var tokens = antiforgery.GetAndStoreTokens(context);
        var hidden = string.Concat(request.GetParameters()
            .Where(p => p.Key is not ("consent" or "__RequestVerificationToken"))
            .Select(p => $"""<input type="hidden" name="{Encode(p.Key)}" value="{Encode((string?)p.Value ?? "")}">"""));
        var redirectHost = Uri.TryCreate(request.RedirectUri, UriKind.Absolute, out var redirect) ? redirect.Authority : request.RedirectUri ?? "";
        var notice = expired ? """<p class="warn">That form expired. Please choose again.</p>""" : "";

        // Apps that registered themselves chose their own name, so anyone could call theirs "Claude". Say so, and point
        // at the one thing they can't fake: where the app sends you back to.
        var unverified = request.ClientId?.StartsWith(McpResource.DynamicClientPrefix, StringComparison.Ordinal) == true
            ? $"""<p class="warn"><strong>Unverified app.</strong> It named itself; Inklayer can't check who made it. Only allow it if you started connecting it and <strong>{Encode(redirectHost)}</strong> is where you expect it to run.</p>"""
            : "";

        return $"""
            <!DOCTYPE html>
            <html lang="en"><head><meta charset="utf-8"><title>Inklayer: allow {Encode(appName)}?</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
            body{"{"}font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f2328{"}"}
            @media (prefers-color-scheme:dark){"{"}body{"{"}background:#16161a;color:#eee{"}"}.box{"{"}border-color:#333!important{"}"}{"}"}
            .box{"{"}border:1px solid #ddd;border-radius:14px;padding:1rem 1.25rem;margin:1.25rem 0{"}"}
            ul{"{"}padding-left:1.2rem{"}"} .muted{"{"}color:#777;font-size:.9rem{"}"} .warn{"{"}color:#b45309{"}"}
            button{"{"}font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #ccc;background:none;color:inherit;cursor:pointer;margin-right:.5rem{"}"}
            button.allow{"{"}background:#6d28d9;border-color:#6d28d9;color:#fff{"}"}
            </style></head><body>
            <h1>Allow {Encode(appName)} to use Inklayer?</h1>
            {notice}
            {unverified}
            <p><strong>{Encode(appName)}</strong> wants to use Inklayer as <strong>{Encode(userName)}</strong>.</p>
            <div class="box"><p>It will be able to do anything you can:</p>
            <ul><li>read comments, replies and docs in your organisations</li>
            <li>reply to and resolve comments, and create, edit and delete docs, where your role allows</li></ul></div>
            <p class="muted">It will send you back to <strong>{Encode(redirectHost)}</strong>. Only allow apps you trust.
            You can disconnect it at any time under Connected apps in Inklayer.</p>
            <form method="post" action="{Encode(context.Request.PathBase + context.Request.Path)}">
            {hidden}<input type="hidden" name="{Encode(tokens.FormFieldName)}" value="{Encode(tokens.RequestToken ?? "")}">
            <button class="allow" type="submit" name="consent" value="allow">Allow</button>
            <button type="submit" name="consent" value="deny">Don't allow</button>
            </form></body></html>
            """;
    }

    private static string Encode(string value) => WebUtility.HtmlEncode(value);
}
