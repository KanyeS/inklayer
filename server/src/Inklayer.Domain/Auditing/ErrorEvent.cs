namespace Inklayer.Domain.Auditing;

/// <summary>
/// An unexpected server error, for instance administrators' activity log. Only what helps diagnose it is kept: never request
/// bodies or query strings, which can carry tokens. Old entries are pruned (see <see cref="Retention"/>).
/// </summary>
public sealed class ErrorEvent
{
    public static readonly TimeSpan Retention = TimeSpan.FromDays(30);
    public const int MaxMessageLength = 500;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public DateTime OccurredAt { get; init; }

    /// <summary>The signed-in user whose request failed, if any.</summary>
    public Guid? UserId { get; init; }

    public required string Method { get; init; }

    /// <summary>The request path without its query string.</summary>
    public required string Path { get; init; }

    public int StatusCode { get; init; }

    /// <summary>Exception type and message, truncated to <see cref="MaxMessageLength"/>.</summary>
    public required string Message { get; init; }

    /// <summary>Matches the server log entry, so the full stack trace can be found there.</summary>
    public string? TraceId { get; init; }
}
