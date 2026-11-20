using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Inklayer.Api.Hosting;

/// <summary>
/// Makes the OpenAPI document describe what the server sends, so the client's generated types are exact
/// (<c>client/packages/api</c>). Only the document changes; how requests are read stays the same.
/// </summary>
internal static class OpenApiSchemaRules
{
    public static OpenApiOptions UseInklayerSchemaRules(this OpenApiOptions options) =>
        options.AddSchemaTransformer((schema, context, _) =>
        {
            Apply(schema, context.JsonTypeInfo);
            ListAllowedValues(schema, context.JsonPropertyInfo?.AttributeProvider);
            return Task.CompletedTask;
        });

    private static void Apply(OpenApiSchema schema, System.Text.Json.Serialization.Metadata.JsonTypeInfo info)
    {
        // Numbers may be sent as strings, but the server always writes them as numbers.
        if (schema.Type is { } type && (type.HasFlag(JsonSchemaType.Integer) || type.HasFlag(JsonSchemaType.Number)) && type.HasFlag(JsonSchemaType.String))
        {
            schema.Type = type & ~JsonSchemaType.String;
            schema.Pattern = null;
        }

        // A nullable enum is written as oneOf [null, the enum], so the enum itself never holds null.
        if (schema.Enum is { Count: > 0 } values)
        {
            for (var i = values.Count - 1; i >= 0; i--)
            {
                if (values[i] is null || values[i]!.GetValueKind() == System.Text.Json.JsonValueKind.Null)
                {
                    values.RemoveAt(i);
                }
            }
        }

        // Requests: a property that may be null, or has a default, may be left out (System.Text.Json fills it in).
        if (info.Type.Name.EndsWith("Request", StringComparison.Ordinal) && schema.Required is { } required)
        {
            foreach (var property in info.Properties)
            {
                if (property.IsSetNullable || property.AssociatedParameter is { HasDefaultValue: true })
                {
                    required.Remove(property.Name);
                }
            }
        }
    }

    /// <summary>
    /// A string property marked <c>[property: AllowedValues(...)]</c> is one of those values (for a list, each item is),
    /// so the client gets a union type rather than <c>string</c>.
    /// </summary>
    private static void ListAllowedValues(OpenApiSchema schema, System.Reflection.ICustomAttributeProvider? attributes)
    {
        if (attributes?.GetCustomAttributes(typeof(AllowedValuesAttribute), inherit: false) is not [AllowedValuesAttribute allowed, ..])
        {
            return;
        }

        var target = schema.Items as OpenApiSchema ?? schema;
        target.Enum = [.. allowed.Values.Select(v => (JsonNode)JsonValue.Create(v?.ToString())!)];
    }
}
