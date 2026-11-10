<?php

namespace ccxt\async;

use Psr\Http\Message\UriInterface;
use React\EventLoop\LoopInterface;
use React\Http\Io\ClientConnectionManager;
use React\Socket\Connection;
use React\Socket\ConnectionInterface;
use React\Socket\ConnectorInterface;

/**
 * Connection manager for the ReactPHP HTTP client that keeps idle connections
 * open between requests, so sequential calls to the same host reuse one
 * TCP/TLS connection instead of paying a full handshake every time.
 *
 * react/http's own ClientConnectionManager hands a connection back after a
 * complete keep-alive response, but only holds it for 1 ms before closing it,
 * so two requests never share a connection unless they are issued in the same
 * tick. Every REST call then costs a TCP + TLS handshake on top of the round
 * trip (~4x the wall time of the other ccxt ports in a like-for-like benchmark).
 * This subclass pools clean idle connections per host the way aiohttp, undici,
 * HttpClient and net/http do for the other language ports.
 *
 * Idle sockets are paused (their read watcher is removed from the event loop)
 * instead of being kept with a timer, so the pool never keeps Loop::run()
 * alive: a script that never calls $exchange->close() still exits as before.
 * A connection the server closed while idle is detected lazily: a zero-timeout
 * stream_select() probe on reuse discards any socket that became readable (EOF
 * or bytes nobody asked for) and a fresh connection is opened instead.
 *
 * The parent class is marked @internal by react/http. composer.json pins the
 * exact react/http version, and Exchange::create_browser() falls back to the
 * stock Browser (one connection per request) if this wiring ever fails.
 */
class KeepAliveConnectionManager extends ClientConnectionManager {

    /** @var ConnectorInterface */
    private $connector;

    /** @var LoopInterface */
    private $loop;

    /**
     * idle connections per "tls://host:port" / "host:port" key, oldest first,
     * each entry an array of the connection and the timestamp it went idle
     *
     * @var array<string, array<int, array{0: ConnectionInterface, 1: float}>>
     */
    private $idle = array();

    /** @var int maximum idle connections kept per host, any further one is closed */
    public $maxIdleConnectionsPerHost = 4;

    /** @var float seconds an idle connection may wait before it is closed instead of reused */
    public $maxIdleTime = 30.0;

    public function __construct(ConnectorInterface $connector, LoopInterface $loop) {
        parent::__construct($connector, $loop);
        $this->connector = $connector;
        $this->loop = $loop;
    }

    /**
     * @return string|null the connector uri for the host, or null for a scheme the HTTP client does not speak
     */
    private static function connection_key(UriInterface $uri) {
        $scheme = $uri->getScheme();
        if ($scheme !== 'https' && $scheme !== 'http') {
            return null;
        }
        $port = $uri->getPort();
        if ($port === null) {
            $port = ($scheme === 'https') ? 443 : 80;
        }
        return (($scheme === 'https') ? 'tls://' : '') . $uri->getHost() . ':' . $port;
    }

    /**
     * @return \React\Promise\PromiseInterface<ConnectionInterface>
     */
    public function connect(UriInterface $uri) {
        $key = self::connection_key($uri);
        if ($key === null) {
            return \React\Promise\reject(new \InvalidArgumentException('Invalid request URL given'));
        }
        while (isset($this->idle[$key]) && count($this->idle[$key]) > 0) {
            // most recently released first, it is the one most likely to still be open
            $entry = array_pop($this->idle[$key]);
            if (count($this->idle[$key]) === 0) {
                unset($this->idle[$key]);
            }
            $connection = $entry[0];
            $idleFor = microtime(true) - $entry[1];
            if ($idleFor <= $this->maxIdleTime && self::is_reusable($connection)) {
                $connection->resume();
                return \React\Promise\resolve($connection);
            }
            $connection->close();
        }
        return $this->connector->connect($key);
    }

    /**
     * Called by the HTTP client once a response completed and both sides allow keep-alive.
     *
     * @return void
     */
    public function keepAlive(UriInterface $uri, ConnectionInterface $connection) {
        $key = self::connection_key($uri);
        $poolIsFull = isset($this->idle[$key]) && (count($this->idle[$key]) >= $this->maxIdleConnectionsPerHost);
        // only pool a plain socket connection whose stream can be probed on reuse
        if (($key === null) || $poolIsFull || !($connection instanceof Connection) || !$connection->isReadable() || !$connection->isWritable()) {
            $connection->close();
            return;
        }
        // stop watching the socket, nothing is expected on it while idle and a
        // watcher would keep the event loop running after the script is done
        $connection->pause();
        $this->idle[$key][] = array($connection, microtime(true));
    }

    /**
     * @return void
     */
    public function cleanUpConnection(ConnectionInterface $connection) {
        foreach ($this->idle as $key => $entries) {
            foreach ($entries as $index => $entry) {
                if ($entry[0] === $connection) {
                    unset($this->idle[$key][$index]);
                    if (count($this->idle[$key]) === 0) {
                        unset($this->idle[$key]);
                    } else {
                        $this->idle[$key] = array_values($this->idle[$key]);
                    }
                    $connection->close();
                    return;
                }
            }
        }
    }

    /**
     * Closes every pooled connection, called from Exchange::close()
     *
     * @return void
     */
    public function closeIdleConnections() {
        $idle = $this->idle;
        $this->idle = array();
        foreach ($idle as $entries) {
            foreach ($entries as $entry) {
                $entry[0]->close();
            }
        }
    }

    /**
     * @return int number of idle connections currently pooled
     */
    public function countIdleConnections() {
        $count = 0;
        foreach ($this->idle as $entries) {
            $count += count($entries);
        }
        return $count;
    }

    /**
     * An idle keep-alive connection has nothing to read. If the socket became
     * readable the server closed it (EOF) or sent bytes nobody asked for, and
     * either way it must not carry another request.
     *
     * @return bool
     */
    private static function is_reusable(Connection $connection) {
        if (!$connection->isReadable() || !$connection->isWritable()) {
            return false;
        }
        $stream = $connection->stream;
        if (!is_resource($stream)) {
            return false;
        }
        $read = array($stream);
        $write = null;
        $except = null;
        $ready = @stream_select($read, $write, $except, 0, 0);
        // a failed select is not worth trusting either
        return $ready === 0;
    }
}
