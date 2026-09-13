using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace ccxt;

using dict = Dictionary<string, object>;

public partial class BaseExchange
{

    public static bool isValidJson(string json)
    {
        json = json.Replace("\n", "").Replace("\r", "").Trim();
        if ((json.StartsWith("{") && json.EndsWith("}")) || // For object
            (json.StartsWith("[") && json.EndsWith("]"))) //For array
        {
            return true;
        }
        return false;
    }

    public string stringifyObject(object d2)
    {
        var output = "";

        if (d2 == null)
            return output;

        if (d2.GetType() == typeof(dict))
        {
            var d = (dict)d2;
            if (d == null)
                return output;

            foreach (var key in d.Keys)
            {
                output += key + ", " + d[key] + "\n";
            }
            return output;
        }
        else if (d2.GetType() == typeof(List<object>))
        {
            var d = (List<object>)d2;
            if (d == null)
                return output;

            foreach (var key in d)
            {
                output += key + "\n";
            }
            return output;
        }
        return (string)output;
    }
}

public static class JsonHelper
{
    // Single pass over the JsonTextReader tokens, materialised straight into the
    // Dictionary<string, object> / List<object> shapes the transpiled code reads.
    // The previous implementation first loaded a complete JToken tree
    // (JToken.ReadFrom) and then walked it a second time with LINQ
    // (ToDictionary / Select.ToList), i.e. two passes plus a throwaway tree; on a
    // 1000-level order book that was roughly half of parseJson's time and memory.
    // Value semantics are unchanged:
    //   object  -> Dictionary<string, object> (a duplicate key keeps its first
    //              position and takes the last value, exactly what JObject.Load's
    //              default DuplicatePropertyNameHandling.Replace produced)
    //   array   -> List<object>
    //   integer -> long, or System.Numerics.BigInteger when the literal does not fit
    //   float   -> double
    //   string  -> string (DateParseHandling.None keeps ISO dates as strings,
    //              https://github.com/JamesNK/Newtonsoft.Json/issues/1241)
    //   true/false -> bool, null/undefined -> null
    // Malformed input still surfaces as Newtonsoft's JsonReaderException, and, as
    // before, only the first root value is read (trailing content is not validated).
    public static object Deserialize(string json)
    {
        using (var sr = new StringReader(json))
        using (var jr = new JsonTextReader(sr) { DateParseHandling = DateParseHandling.None })
        {
            if (!jr.Read())
            {
                throw new JsonReaderException("Error reading JToken from JsonReader.");
            }
            return ReadValue(jr);
        }
    }

    // the reader is positioned ON the value token
    private static object ReadValue(JsonReader jr)
    {
        switch (jr.TokenType)
        {
            case JsonToken.StartObject:
                return ReadObject(jr);
            case JsonToken.StartArray:
                return ReadArray(jr);
            case JsonToken.Float:
                {
                    // FloatParseHandling.Double already boxes a double; the conversion
                    // only runs for a reader configured to produce decimals
                    var value = jr.Value;
                    return (value is double) ? value : Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture);
                }
            case JsonToken.Integer:
            case JsonToken.String:
            case JsonToken.Boolean:
            case JsonToken.Date:
            case JsonToken.Bytes:
            case JsonToken.Comment: // a root-level comment: JToken.ReadFrom also returned its text
                return jr.Value;
            case JsonToken.Null:
            case JsonToken.Undefined:
                return null;
            default:
                throw new JsonReaderException("Error reading JToken from JsonReader. Unexpected token: " + jr.TokenType);
        }
    }

    private static Dictionary<string, object> ReadObject(JsonReader jr)
    {
        var result = new Dictionary<string, object>();
        while (jr.Read())
        {
            switch (jr.TokenType)
            {
                case JsonToken.PropertyName:
                    {
                        var name = (string)jr.Value;
                        // comments between a name and its value are skipped, like JObject.Load does
                        do
                        {
                            if (!jr.Read())
                            {
                                throw new JsonReaderException("Unexpected end of content while loading JObject.");
                            }
                        } while (jr.TokenType == JsonToken.Comment);
                        result[name] = ReadValue(jr);
                        break;
                    }
                case JsonToken.EndObject:
                    return result;
                case JsonToken.Comment:
                    break;
                default:
                    throw new JsonReaderException("Unexpected token when loading JObject: " + jr.TokenType);
            }
        }
        throw new JsonReaderException("Unexpected end of content while loading JObject.");
    }

    private static List<object> ReadArray(JsonReader jr)
    {
        var result = new List<object>();
        while (jr.Read())
        {
            switch (jr.TokenType)
            {
                case JsonToken.EndArray:
                    return result;
                case JsonToken.Comment:
                    break;
                default:
                    result.Add(ReadValue(jr));
                    break;
            }
        }
        throw new JsonReaderException("Unexpected end of content while loading JArray.");
    }

    // kept for callers that already hold a JToken; Deserialize no longer goes through it
    public static object ToObject(JToken token)
    {
        switch (token.Type)
        {
            case JTokenType.Object:
                return token.Children<JProperty>()
                            .ToDictionary(prop => prop.Name,
                                          prop => ToObject(prop.Value));

            case JTokenType.Array:
                return token.Select(ToObject).ToList();

            case JTokenType.Float:
                return token.ToObject<double>();

            default:
                return ((JValue)token).Value;
        }
    }
}
