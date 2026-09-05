import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
    level: config.logLevel,
    // Defence in depth. By design no code path hands a plaintext key to the logger — the store
    // never retains one past the digest — but LOG_LEVEL=trace, an ad-hoc log.info({ headers }), or
    // a future error path all would. This makes it structurally impossible rather than merely
    // currently-true. A key in a log file is a credential in a log file, readable by anyone with
    // log access and long outliving the request.
    redact: {
        paths: [
            'req.headers["x-api-key"]', 'req.headers.authorization',
            'headers["x-api-key"]', 'headers.authorization',
        ],
        censor: '[redacted]',
    },
    transport: process.env['NODE_ENV'] === 'production' ? undefined : { target: 'pino-pretty' },
});

// A SEPARATE destination for the records that are evidence rather than diagnostics: one line per
// request, and one per routing recommendation. They are split out because the shared log is
// overwhelmingly connector noise — measured on the live box, 12 event lines out of 1,952,180 — so
// an ingester tailing it would read gigabytes to find kilobytes, and the records would age out on
// logrotate's schedule rather than their own.
//
// Rotate this file with `create`, NOT `copytruncate`: under copytruncate a tailer silently loses
// everything between its committed offset and the truncation point, which is a recurring undercount
// presented as success.
export const auditLogger = config.auditLogFile === undefined
    ? logger
    : pino(
        { level: config.auditLogLevel, base: undefined },
        pino.destination({ dest: config.auditLogFile, sync: false, mkdir: true }),
    );
