import type { ShardToParentMessage } from './messages.js';

// The raw shape of process.send(), narrowed to what this module uses. Injected rather than reached
// for so the backpressure rules below are testable without forking a process.
export type RawSend = (
    message: ShardToParentMessage,
    sendHandle: undefined,
    options: undefined,
    callback: () => void,
) => boolean;

export interface IpcStats {
    sentBooks: number;
    droppedBooks: number;
    droppedHealth: number;
}

// process.send() returns false when the IPC pipe is full. That return value used to be discarded,
// which is how a shard reached 19.8GB: measured, 96.3% of sends were backpressured against an idle
// parent, and libuv queued every one of them in native write buffers.
//
// Book AND health messages are IDEMPOTENT SNAPSHOTS, so the right response to a full pipe is to
// drop them. A dropped one costs nothing — another arrives milliseconds later and supersedes it,
// and health is re-flushed wholesale every HEALTH_FLUSH_MS regardless. A queued one costs memory
// until the process dies. Health used to bypass this gate entirely, which was exactly backwards:
// its rate is proportional to the FAILURE rate, so the pipe was hit hardest by the messages that
// were exempt from the protection, precisely when the parent was least able to drain them.
//
// Fee and loop messages are rare and bounded, and are still sent unconditionally.
export function createIpcSender (rawSend: RawSend | undefined) {
    let sentBooks = 0;
    let droppedBooks = 0;
    let droppedHealth = 0;
    let pipeFull = false;

    const send = (message: ShardToParentMessage): void => {
        if (rawSend === undefined) return;
        if (pipeFull) {
            if (message.type === 'book') { droppedBooks += 1; return; }
            if (message.type === 'health') { droppedHealth += 1; return; }
        }
        // The callback fires once the message is flushed; until then treat the pipe as full so the
        // next snapshot is dropped rather than enqueued behind this one.
        const accepted = rawSend(message, undefined, undefined, () => { pipeFull = false; });
        if (message.type === 'book') sentBooks += 1;
        if (!accepted) pipeFull = true;
    };

    const stats = (): IpcStats => ({ sentBooks, droppedBooks, droppedHealth });

    return { send, stats };
}
