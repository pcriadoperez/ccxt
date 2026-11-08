// Timezone helpers. Users store an IANA timezone so daylight saving works for briefs and quiet hours.

export function localParts (tz: string, ts: number): { date: string, minutes: number, hhmm: string, weekday: string } {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat ('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts (new Date (ts));
    } catch {
        return localParts ('UTC', ts);
    }
    const get = (type: string) => (parts.find ((p) => p.type === type)?.value || '00');
    const hour = Number (get ('hour')) % 24;
    const minute = Number (get ('minute'));
    return {
        date: get ('year') + '-' + get ('month') + '-' + get ('day'),
        minutes: hour * 60 + minute,
        hhmm: String (hour).padStart (2, '0') + ':' + String (minute).padStart (2, '0'),
        weekday: get ('weekday'),
    };
}

export function offsetMinutes (tz: string, ts: number): number {
    const p = localParts (tz, ts);
    const u = localParts ('UTC', ts);
    let diff = p.minutes - u.minutes;
    if (p.date > u.date) {
        diff += 1440;
    } else if (p.date < u.date) {
        diff -= 1440;
    }
    return diff;
}

export function inQuietHours (quietStart: number | null, quietEnd: number | null, tz: string, ts: number): boolean {
    if (quietStart === null || quietEnd === null || quietStart === quietEnd) {
        return false;
    }
    const m = localParts (tz, ts).minutes;
    return quietStart < quietEnd ? (m >= quietStart && m < quietEnd) : (m >= quietStart || m < quietEnd);
}

// Pick a representative IANA zone for a UTC offset chosen in onboarding (preferring big, well-known zones).
const PREFERRED = [
    'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
    'Atlantic/Azores', 'Europe/London', 'Europe/Madrid', 'Europe/Berlin', 'Europe/Kyiv', 'Europe/Istanbul', 'Asia/Dubai', 'Asia/Karachi',
    'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Honolulu',
    'America/Anchorage', 'America/Mexico_City', 'America/Bogota', 'Africa/Lagos', 'Africa/Cairo', 'Asia/Jakarta', 'Asia/Manila', 'Asia/Seoul',
];

export function zoneForOffset (offset: number, ts: number): string {
    for (const z of PREFERRED) {
        if (offsetMinutes (z, ts) === offset) {
            return z;
        }
    }
    let all: string[] = [];
    try {
        all = (Intl as any).supportedValuesOf ('timeZone');
    } catch {
        all = [];
    }
    for (const z of all) {
        if (offsetMinutes (z, ts) === offset) {
            return z;
        }
    }
    return 'UTC';
}

export function isValidZone (tz: string): boolean {
    try {
        new Intl.DateTimeFormat ('en-GB', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

export function parseHHMM (s: string): number | undefined {
    const m = s.trim ().match (/^(\d{1,2})(?::(\d{2}))?$/);
    if (!m) {
        return undefined;
    }
    const h = Number (m[1]);
    const min = Number (m[2] || 0);
    if (h > 23 || min > 59) {
        return undefined;
    }
    return h * 60 + min;
}

export function minutesToHHMM (m: number): string {
    return String (Math.floor (m / 60)).padStart (2, '0') + ':' + String (m % 60).padStart (2, '0');
}
