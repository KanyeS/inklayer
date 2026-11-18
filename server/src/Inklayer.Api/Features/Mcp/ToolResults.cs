using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using ModelContextProtocol;

namespace Inklayer.Api.Features.Mcp;

/// <summary>
/// The MCP tools call the same endpoint handlers as the REST API, so permissions and validation are identical. This turns a
/// handler's result into the tool's answer, or into an error the assistant can read (the same message the app shows).
/// </summary>
internal static class ToolResults
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        // Readable text for the assistant (é, emoji) rather than \u escapes. The output is JSON for a model, never HTML.
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>The handler's value, or an <see cref="McpException"/> saying why it failed.</summary>
    public static T Value<T>(IResult result) => Unwrap(result) is T value ? value : throw new McpException("The server returned something unexpected.");

    /// <summary>Succeeds or throws; for results without a value (204).</summary>
    public static void Ok(IResult result) => Unwrap(result);

    public static string ToJson(object? value) => JsonSerializer.Serialize(value, Json);

    private static object? Unwrap(IResult result)
    {
        var status = (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK;
        switch (result)
        {
            case ProblemHttpResult problem:
                throw new McpException(Message(problem.ProblemDetails));
            case IValueHttpResult { Value: HttpValidationProblemDetails validation }:
                throw new McpException(string.Join(" ", validation.Errors.SelectMany(e => e.Value)) is { Length: > 0 } errors ? errors : Message(validation));
            case IValueHttpResult value when status < 400:
                return value.Value;
        }

        return status switch
        {
            < 400 => null,
            StatusCodes.Status404NotFound => throw new McpException("Not found, or you don't have access to it."),
            StatusCodes.Status401Unauthorized => throw new McpException("You're not signed in, or your account was disabled."),
            StatusCodes.Status403Forbidden => throw new McpException("Your role doesn't allow this."),
            _ => throw new McpException($"That didn't work (status {status})."),
        };
    }

    private static string Message(ProblemDetails problem) =>
        string.Join(" ", new[] { problem.Title, problem.Detail }.Where(s => !string.IsNullOrWhiteSpace(s))) is { Length: > 0 } message ? message : "That didn't work.";
}
