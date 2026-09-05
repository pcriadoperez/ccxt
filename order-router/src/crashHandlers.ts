import type { Logger } from 'pino';

// Node's default behaviour for an uncaught exception or an unhandled rejection is to print to
// stderr and exit. That is the right ACTION — after an uncaught throw the process state is
// undefined and continuing is how a router starts serving wrong answers — but it is the wrong
// RECORD: the crash lands in whatever caught stderr rather than in the structured log everything
// else is read from, so the one event worth explaining is the one event with no context.
//
// These handlers keep the action and fix the record: log through pino, flush, then exit non-zero
// so the supervisor restarts. They deliberately do NOT swallow. A handler that logs and continues
// converts a loud crash into a process that is still listening while holding unknown state, which
// for a service whose answers move money is strictly worse than being down.
export function installCrashHandlers (logger: Logger, processName: string): void {
    const die = (event: string, err: unknown) => {
        try {
            logger.fatal({ err, event, processName }, 'unhandled_error_exiting');
        } catch {
            // the logger itself may be the thing that broke; stderr is the last resort
            // eslint-disable-next-line no-console
            console.error(processName, event, err);
        }
        // A small delay lets pino's async transport flush; unref'd so it cannot itself hold the
        // process open if the write completes immediately.
        const timer = setTimeout(() => process.exit(1), 100);
        if (typeof timer.unref === 'function') timer.unref();
    };
    process.on('uncaughtException', (err) => die('uncaughtException', err));
    process.on('unhandledRejection', (reason) => die('unhandledRejection', reason));
}
