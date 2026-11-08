// Date extraction. Every function returns YYYY-MM-DD or null; nothing here throws.

export type DateOrder = 'ymd' | 'mdy' | 'dmy';

const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function pad (n: number): string {
    return String (n).padStart (2, '0');
}

export function isoDay (d: Date): string {
    return d.toISOString ().slice (0, 10);
}

function build (y: number, m: number, d: number, now: Date): string | null {
    const maxYear = now.getUTCFullYear () + 1;
    if (y < 2015 || y > maxYear || m < 1 || m > 12 || d < 1 || d > 31) {
        return null;
    }
    const date = new Date (Date.UTC (y, m - 1, d));
    if (date.getUTCMonth () !== m - 1) {
        return null; // 2026-02-30
    }
    return `${y}-${pad (m)}-${pad (d)}`;
}

function monthNumber (name: string): number {
    return MONTHS[name.toLowerCase ().slice (0, 3)] ?? 0;
}

interface Candidate {
    index: number;
    value: string;
}

type Matcher = (m: RegExpExecArray, order: DateOrder | undefined, now: Date) => string | null;

const MATCHERS: [RegExp, Matcher][] = [
    // 2026-11-05, 2026/11/05, 2026.11.05, 2026-11-05T10:00:00Z, mixed separators (Gate "2026.05-12")
    [ /(?<![\d.])(20\d\d)([-/.])(\d{1,2})[-/.](\d{1,2})(?![\d]|\.\d)/g, (m, _o, now) => build (+m[1], +m[3], +m[4], now) ],
    // 2026-OCT-01, 2025-Aug-14, 2026-Mar-9 (Coinbase), 2026 Nov 5
    [ new RegExp (`(?<!\\d)(20\\d\\d)[-/ ]${MONTH_RE}[-/ ](\\d{1,2})(?!\\d)`, 'gi'), (m, _o, now) => build (+m[1], monthNumber (m[2]), +m[3], now) ],
    // 2026年11月5日
    [ /(20\d\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, (m, _o, now) => build (+m[1], +m[2], +m[3], now) ],
    // 2026년 11월 13일 (Korean)
    [ /(20\d\d)\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, (m, _o, now) => build (+m[1], +m[2], +m[3], now) ],
    // 05.11.2026 (dmy), 11/05/2026 (mdy by default), 05-11-2026 (dmy)
    [ /(?<![\d.\/-])(\d{1,2})([./-])(\d{1,2})\2(20\d\d)(?!\d)/g, (m, order, now) => {
        const a = +m[1];
        const b = +m[3];
        const y = +m[4];
        if (a > 12 && b <= 12) {
            return build (y, b, a, now);
        }
        if (b > 12 && a <= 12) {
            return build (y, a, b, now);
        }
        const effective = (order === 'mdy' || order === 'dmy') ? order : ((m[2] === '/') ? 'mdy' : 'dmy');
        return (effective === 'mdy') ? build (y, a, b, now) : build (y, b, a, now);
    } ],
    // Nov 5, 2026 / November 5th, 2026 / Nov. 5 2026
    [ new RegExp (`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d\\d)\\b`, 'gi'), (m, _o, now) => build (+m[3], monthNumber (m[1]), +m[2], now) ],
    // 5 Nov 2026 / 06 Nov 2026 (RFC 822) / 5th of November, 2026
    [ new RegExp (`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(20\\d\\d)\\b`, 'gi'), (m, _o, now) => build (+m[3], monthNumber (m[2]), +m[1], now) ],
];

function candidates (text: string, order: DateOrder | undefined, now: Date): Candidate[] {
    const found: Candidate[] = [];
    for (const [ re, fn ] of MATCHERS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec (text)) !== null) {
            const value = fn (m, order, now);
            if (value) {
                found.push ({ index: m.index, value });
            }
        }
    }
    return found.sort ((a, b) => a.index - b.index);
}

// A heading that is only a month ("Nov 2025", "December 2025", "## Feb 2026"): the first of that
// month. Only whole texts (or whole " / "-separated heading context parts) count, so a month named
// in prose never dates an entry.
const MONTH_ONLY = new RegExp (`^\\s*(?:#{1,6}\\s*)?${MONTH_RE}\\.?,?\\s+(20\\d\\d)\\s*:?\\s*$`, 'i');

export function monthOnlyDate (text: string, now: Date = new Date ()): string | null {
    for (const part of text.split (/\s+\/\s+|\n/)) {
        const m = MONTH_ONLY.exec (part);
        if (m) {
            return build (+m[2], monthNumber (m[1]), 1, now);
        }
    }
    return null;
}

// First date found anywhere in `text`; else a month-only heading (monthOnlyDate).
export function findDate (text: string | undefined | null, order?: DateOrder, now: Date = new Date ()): string | null {
    if (!text) {
        return null;
    }
    const all = candidates (text, order, now);
    return all.length ? all[0].value : monthOnlyDate (text, now);
}

// Date using an optional regex with one capture group (SourceConfig.date.pattern).
export function extractDate (text: string | undefined | null, pattern: string | undefined, order?: DateOrder, now: Date = new Date ()): string | null {
    if (!text) {
        return null;
    }
    if (pattern) {
        const m = new RegExp (pattern, 'i').exec (text);
        if (!m) {
            return null;
        }
        return findDate (m[1] ?? m[0], order, now);
    }
    return findDate (text, order, now);
}

// Phrases announcing when a change takes effect; the date must follow within 25 characters.
//   English: "Effective date:", "Effective Time:", "effective from/on/as of", "Effective Apr 30, 2026",
//            "will take effect", "release date", "Release 10.11.2026", "go(es) live (on)",
//            "will be released/removed/deprecated/retired/... (on)", "launch/sunset/deprecation date"
//   Korean:  "적용 예정일", "적용 일시", "적용일", "시행일", "시행 예정" (before the date), and
//            "적용될 예정", "지원 종료" ... after a Korean date (TRAILING_KO)
//   Chinese: "生效时间", "生效日期", "上线时间"
const EFFECTIVE_PHRASES = new RegExp ([
    `effective\\s+(?:date|time|from|on|as\\s+of|starting)`,
    `effective\\s*:`,
    `\\beffective(?=\\s+(?:20\\d\\d|${MONTH_RE}\\b|\\d{1,2}\\s+${MONTH_RE}))`,
    `will\\s+(?:take|come\\s+into)\\s+effect`,
    `takes?\\s+effect`,
    `release\\s+date`,
    `scheduled\\s+release`,
    `\\brelease\\b`,
    `will\\s+be\\s+(?:fully\\s+|completely\\s+|permanently\\s+|officially\\s+)?(?:released|launched|deployed|removed|decommissioned|discontinued|retired|deprecated)(?:\\s+on)?`,
    `to\\s+be\\s+released`,
    `go(?:es)?\\s+live(?:\\s+on)?`,
    `going\\s+live`,
    `launch\\s+date`,
    `sunset\\s+date`,
    `deprecation\\s+date`,
    `적용\\s*(?:예정\\s*)?(?:일시|일자|일)`,
    `시행\\s*(?:예정\\s*)?(?:일시|일자|일)?`,
    `生效(?:时间|日期)`,
    `上线时间`,
].join ('|'), 'gi');

// Korean puts the phrase after the date: "2026년 11월 13일 오전 11시 이후 적용될 예정",
// "2026년 11월 13일 Private WebSocket v1 지원 종료". Up to 40 characters may sit in between.
const TRAILING_KO = /(20\d\d)\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일[^.\n]{0,40}?(?:(?:적용|시행|종료|중단|변경)(?:될|할)?\s*예정|지원\s*종료|적용됩니다|시행됩니다|종료됩니다)/g;

// "Effective date: 2026-11-20", "will take effect on Nov 20, 2026", "Release 10.11.2026",
// "To Be Released: 2026-Oct-13", "2026년 11월 13일 ... 적용될 예정".
export function findEffectiveDate (text: string | undefined | null, order?: DateOrder, now: Date = new Date ()): string | null {
    if (!text) {
        return null;
    }
    EFFECTIVE_PHRASES.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EFFECTIVE_PHRASES.exec (text)) !== null) {
        const window = text.slice (m.index + m[0].length, m.index + m[0].length + 60);
        const all = candidates (window, order, now);
        // the date must follow the phrase closely (after "on", ":", "at" ...)
        if (all.length && all[0].index <= 25) {
            return all[0].value;
        }
    }
    TRAILING_KO.lastIndex = 0;
    while ((m = TRAILING_KO.exec (text)) !== null) {
        const value = build (+m[1], +m[2], +m[3], now);
        if (value) {
            return value;
        }
    }
    return null;
}
