'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var errors = require('../errors.js');
var FastQueue = require('./FastQueue.js');

// ----------------------------------------------------------------------------
class Consumer {
    constructor(fn, currentIndex, options = {}) {
        this.fn = fn;
        this.synchronous = options.synchronous ?? false;
        this.currentIndex = currentIndex;
        this.running = false;
        this.maxBacklogSize = options.maxBacklogSize ?? Consumer.DEFAULT_MAX_BACKLOG_SIZE;
        this.backlog = new FastQueue["default"]();
        this.log = options.log ?? console.log;
    }
    publish(message) {
        this.backlog.enqueue(message);
        if (this.backlog.getLength() > this.maxBacklogSize) {
            this.log(`WebSocket consumer backlog is too large (${this.backlog.getLength()} messages). This might indicate a performance issue or message processing bottleneck. Dropping oldest message.`);
            this.backlog.dequeue();
        }
        this._run();
    }
    async _run() {
        if (this.running) {
            return;
        }
        this.running = true;
        while (!this.backlog.isEmpty()) {
            const message = this.backlog.dequeue();
            if (message) {
                await this._handleMessage(message);
            }
        }
        this.running = false;
    }
    async _handleMessage(message) {
        if (message.metadata.index <= this.currentIndex) {
            return;
        }
        this.currentIndex = message.metadata.index;
        const stream = message.metadata.stream;
        const fn = this.fn;
        const produceError = (err) => {
            const error = new errors.ConsumerFunctionError(err instanceof Error ? err.message : String(err));
            stream.produce('errors', message, error);
        };
        if (this.synchronous) {
            try {
                await fn(message);
            }
            catch (err) {
                produceError(err);
            }
        }
        else {
            try {
                fn(message);
            }
            catch (err) {
                produceError(err);
            }
        }
    }
}
Consumer.DEFAULT_MAX_BACKLOG_SIZE = 1000; // Default maximum number of messages in backlog

exports.Consumer = Consumer;
exports["default"] = Consumer;
