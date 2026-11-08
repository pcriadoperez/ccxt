// Deterministic rule tags. Each tag fires when any of its patterns matches the entry
// title or body (case-insensitive). Keep the list short and obvious; it drives the impact
// chips on docs.ccxt.com and is not meant to be a classifier.
//
// Rules:
//   - one regex per tag in TAG_RULES, tested against "title\nbody";
//   - 'breaking' and 'deprecation' are tested after NEGATIONS are blanked out, so
//     "No removed endpoints", "no breaking changes", "non-breaking", "is not removed",
//     "will not be deprecated" do not fire them (a later un-negated "X was removed" still does);
//   - label lines answered "No" ("Breaking Changes: No", "Deprecations: No") are blanked out too;
//   - 'no longer' is not a negation: "no longer supported" is breaking.

export const TAG_RULES: Record<string, RegExp> = {
    'deprecation': /deprecat|sunset|decommission|discontinu|\bretire|will be removed|end of support|end-of-life|\beol\b/i,
    'breaking': /breaking|no longer|\bremoved\b|\[(?:remove|delete)d?\]|will be changed|incompatib/i,
    'new-endpoint': /new endpoints?|added? (?:a |an |the )?(?:new )?[\w /-]{0,40}endpoints?|new api|new interface|launch(?:ed)? .{0,40}\bapi\b|\badd(?:ed|s)? `?(?:get|post|put|delete|patch)\b.{0,10}\//i,
    'rate-limit': /rate.?limit|\bweight\b|frequency limit|request limit|requests per (?:second|minute)/i,
    'websocket': /websocket|\bws\b|\bwss:|\bstreams?\b|\bchannels?\b|\btopics?\b|subscri(?:be|ption)/i,
    'auth': /signature|\bsign(?:ing|ed)?\b|api.?keys?|authenticat|\bhmac\b|ed25519|\brsa\b|oauth|permission/i,
    'maintenance': /\bmaintenance\b(?! (?:margin|rate|ratio|requirement)s?\b)|upgrade window|\bdowntime\b|system upgrade/i,
    'param-change': /new (?:optional |required )?(?:request |response |push )?(?:parameters?|fields?)|add(?:ed|s)? (?:a |an |the )?(?:new )?(?:optional |required )?(?:request |response |push )?(?:parameter|field)s?|\badd(?:ed|s)? (?:the |a |an )?(?:new )?(?:optional |required )?`?[\w.[\]{}]+`? (?:request |response )?(?:field|parameter)s?\b|response .{0,30}fields?|request parameters?|\benum\b/i,
    // new or removed markets only: "perpetual", "contract" or "market data" alone describe the
    // product an endpoint belongs to, not a listing change.
    'market': /\bnew (?:spot |futures |perpetual |options? |margin |prediction )?(?:markets?|trading pairs?|contracts?|perpetuals?|symbols?|instruments?)\b(?! (?:fields?|types?|status|parameters?|data)\b)|(?<!\b(?:for|by) )\blisting\b(?! (?:the|a|an|all|of|each|every|its|their|your)\b)|\bdelist|\b(?:will be|are|is|has been|have been|newly|now) listed\b|\blaunch(?:es|ed)? (?:new )?(?:[\w-]+ ){0,3}(?:perpetuals?|futures|contracts?|markets?|trading pairs?)\b|\boptions? (?:trading|markets?) (?:launch|is now|are now|now)/i,
};

// "no|not|non|without|zero|nothing" + up to eight words + a breaking/removal/deprecation word.
// The words in between may not end a sentence ("." or ";"), start a contrast ("but", "however")
// or be "longer" ("no longer ... removed" stays affirmative); up to eight words, so "no existing
// FIX Market Data fields are modified or removed" is negated.
export const NEGATIONS = /\b(?:no(?![\s-]+longer\b)|not|non|without|zero|nothing)\b[\s-]+(?:(?!(?:but|however|while|whereas|although|except|yet)\b)[\w`/'()]+(?:\.[\w`/()]+)*,?[\s-]+){0,8}?(?:breaking|removed|removals?|deprecat\w*|retired|incompatib\w*)\b/gi;

// Label lines answered with "No" ("**Breaking Changes:** No", "Deprecations: None", "Breaking: N/A").
export const NEGATED_LABELS = /\b(?:breaking(?:[\s-]+changes?)?|deprecat\w*|removals?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(?:no|none|n\/a)\b/gi;

const NEGATABLE = new Set ([ 'breaking', 'deprecation' ]);

export function ruleTags (title: string, body: string): string[] {
    const text = title + '\n' + body;
    const affirmative = text.replace (NEGATED_LABELS, ' ').replace (NEGATIONS, ' ');
    return Object.keys (TAG_RULES).filter ((tag) => TAG_RULES[tag].test (NEGATABLE.has (tag) ? affirmative : text));
}
