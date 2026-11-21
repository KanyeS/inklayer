using System.Text.Json;
using System.Text.Json.Serialization;

namespace Inklayer.Api.Features.Annotations;

/// <summary>
/// JSON stored as text (a comment's anchor and geometry), written into a response as it is: never parsed or copied.
/// A page's comment list carries every drawing on the page, and parsing each one into a <see cref="JsonElement"/> and
/// cloning it made a busy page cost several times its size in memory per request; a few people loading a page with
/// 100 drawings at once ran the server out of memory. The text was validated as JSON when it was saved.
/// In the OpenAPI document it's described as <see cref="JsonElement"/>, as before (see OpenApiSchemaRules).
/// </summary>
[JsonConverter(typeof(RawJsonConverter))]
public readonly record struct RawJson(string Json);

internal sealed class RawJsonConverter : JsonConverter<RawJson>
{
    public override RawJson Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using var document = JsonDocument.ParseValue(ref reader);
        return new RawJson(document.RootElement.GetRawText());
    }

    public override void Write(Utf8JsonWriter writer, RawJson value, JsonSerializerOptions options) =>
        writer.WriteRawValue(value.Json, skipInputValidation: true);
}
