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
