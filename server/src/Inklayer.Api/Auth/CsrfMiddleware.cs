namespace Inklayer.Api.Auth;

/// <summary>
/// Requires the <see cref="CsrfHeader.Name"/> header on state-changing requests that rely on the session cookie.
/// Bearer-token requests are exempt, because they can't be forged cross-site.
/// </summary>
internal sealed class CsrfMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        var isProtectedPath = request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)
            || request.Path.StartsWithSegments("/auth/logout", StringComparison.OrdinalIgnoreCase);
        var isSafeMethod = HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method) || HttpMethods.IsOptions(request.Method);
        var usesBearer = request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase);

        if (isProtectedPath && !isSafeMethod && !usesBearer && !request.Headers.ContainsKey(CsrfHeader.Name))
        {
            return Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "Missing CSRF header",
                detail: $"Send the '{CsrfHeader.Name}' header with state-changing requests.").ExecuteAsync(context);
        }

        return next(context);
    }
}
