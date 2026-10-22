import { inflateSync } from "node:zlib";
import type { Socket } from "bun";

export interface EddnHeader {
  uploaderID?: string;
  softwareName?: string;
  softwareVersion?: string;
  gameversion?: string;
  gamebuild?: string;
  gatewayTimestamp?: string;
  [key: string]: unknown;
}

export interface EddnEnvelope<TMessage = Record<string, unknown>> {
  $schemaRef: string;
  header: EddnHeader;
  message: TMessage;
}

export interface ParsedZmtpFrame {
  flags: number;
  isMore: boolean;
  isLong: boolean;
  isCommand: boolean;
  body: Buffer;
}

/**
 * 64-byte ZMTP 3.0 NULL greeting frame.
 */
export function createZmtpGreeting(): Buffer {
  const buf = Buffer.alloc(64, 0);
  buf[0] = 0xff;
  buf[8] = 0x01;
  buf[9] = 0x7f;
  buf[10] = 0x03; // Major version 3
  buf[11] = 0x00; // Minor version 0
  buf.write("NULL", 12, "ascii");
  return buf;
}

/**
 * ZMTP 3.0 READY command declaring `Socket-Type: SUB`, followed by
 * a SUBSCRIBE command for the empty topic `""` (all messages).
 */
export function createZmtpSubHandshake(): Buffer {
  // READY command frame: \x04\x19\x05READY\x0BSocket-Type\x00\x00\x00\x03SUB
  const readyFrame = Buffer.from([
    0x04, 0x19, 0x05, 0x52, 0x45, 0x41, 0x44, 0x59, 0x0b, 0x53, 0x6f, 0x63, 0x6b, 0x65, 0x74, 0x2d,
    0x54, 0x79, 0x70, 0x65, 0x00, 0x00, 0x00, 0x03, 0x53, 0x55, 0x42,
  ]);

  // SUBSCRIBE command frame (ZMTP 3.0): \x04\x0A\x09SUBSCRIBE (empty topic "")
  const subscribeCommand = Buffer.from([
    0x04, 0x0a, 0x09, 0x53, 0x55, 0x42, 0x53, 0x43, 0x52, 0x49, 0x42, 0x45,
  ]);

  return Buffer.concat([readyFrame, subscribeCommand]);
}

/**
 * Encodes a ZMTP 3.0 frame (short or long) for testing and command replies.
 */
export function buildZmtpFrame(
  body: Buffer | Uint8Array,
  options?: { isCommand?: boolean; isMore?: boolean },
): Buffer {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const isLong = payload.length > 255;
  let flags = 0;
  if (options?.isMore) flags |= 0x01;
  if (isLong) flags |= 0x02;
  if (options?.isCommand) flags |= 0x04;

  if (!isLong) {
    const header = Buffer.from([flags, payload.length]);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(9);
  header[0] = flags;
  header.writeBigUInt64BE(BigInt(payload.length), 1);
  return Buffer.concat([header, payload]);
}

/**
 * Parses all complete ZMTP 3.0 frames from a streaming byte buffer, returning
 * the parsed frames and the remaining unconsumed tail buffer.
 */
export function parseZmtpFrames(buffer: Buffer): {
  frames: ParsedZmtpFrame[];
  remainder: Buffer;
} {
  const frames: ParsedZmtpFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const flags = buffer[offset]!;
    const isMore = (flags & 0x01) !== 0;
    const isLong = (flags & 0x02) !== 0;
    const isCommand = (flags & 0x04) !== 0;
    const headerSize = isLong ? 9 : 2;

    if (buffer.length - offset < headerSize) {
      break;
    }

    let bodyLength: number;
    if (isLong) {
      const bigLen = buffer.readBigUInt64BE(offset + 1);
      if (bigLen > BigInt(16 * 1024 * 1024)) {
        throw new Error(`ZMTP frame length ${bigLen} exceeds 16MB safety limit`);
      }
      bodyLength = Number(bigLen);
    } else {
      bodyLength = buffer[offset + 1]!;
    }

    const totalSize = headerSize + bodyLength;
    if (buffer.length - offset < totalSize) {
      break;
    }

    const body = Buffer.from(buffer.subarray(offset + headerSize, offset + totalSize));
    frames.push({
      flags,
      isMore,
      isLong,
      isCommand,
      body,
    });

    offset += totalSize;
  }

  const remainder =
    offset === 0
      ? buffer
      : offset >= buffer.length
        ? Buffer.alloc(0)
        : Buffer.from(buffer.subarray(offset));

  return { frames, remainder };
}

/**
 * Builds a ZMTP 3.0 PONG command frame in response to a PING command body.
 */
export function handleZmtpCommandFrame(commandBody: Buffer): Buffer | null {
  if (commandBody.length < 1) return null;
  const nameLen = commandBody[0]!;
  if (commandBody.length < 1 + nameLen) return null;

  const commandName = commandBody.subarray(1, 1 + nameLen).toString("ascii");
  if (commandName === "PING") {
    // PING body format: [4, 'P','I','N','G', ttl_hi, ttl_lo, ...context]
    const context = commandBody.length > 7 ? commandBody.subarray(7) : Buffer.alloc(0);
    const pongBody = Buffer.concat([Buffer.from([0x04, 0x50, 0x4f, 0x4e, 0x47]), context]);
    return buildZmtpFrame(pongBody, { isCommand: true });
  }

  return null;
}

/**
 * Decompresses a zlib-compressed EDDN message frame and parses it as JSON.
 */
export function decodeEddnPayload(compressedBody: Buffer): EddnEnvelope {
  const inflated = inflateSync(compressedBody);
  const text = inflated.toString("utf8");
  return JSON.parse(text) as EddnEnvelope;
}

export function parseZmqTcpEndpoint(endpointUrl: string): { hostname: string; port: number } {
  const normalized = endpointUrl.trim().replace(/^tcp:\/\//i, "http://");
  const parsed = new URL(normalized);
  const hostname = parsed.hostname || "eddn.edcd.io";
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 9500;
  return { hostname, port };
}

export interface ZmtpSubClientOptions {
  url: string;
  idleTimeoutMs?: number;
  onMessage: (envelope: EddnEnvelope) => void | Promise<void>;
  onError?: (err: Error) => void;
}

/**
 * Resilient pure-Bun ZeroMQ (ZMTP 3.0) `SUB` client for streaming live EDDN telemetry.
 */
export class ZmtpSubClient {
  private readonly url: string;
  private readonly idleTimeoutMs: number;
  private readonly onMessage: (envelope: EddnEnvelope) => void | Promise<void>;
  private readonly onError?: (err: Error) => void;

  private socket: Socket<undefined> | null = null;
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: Timer | null = null;
  private watchdogTimer: Timer | null = null;
  private lastDataTimestamp = 0;

  constructor(options: ZmtpSubClientOptions) {
    this.url = options.url;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.onMessage = options.onMessage;
    this.onError = options.onError;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempts = 0;
    void this.connect();
  }

  public stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        // Ignore socket close errors
      }
      this.socket = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    this.clearTimers();

    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        // Ignore
      }
      this.socket = null;
    }

    const baseDelayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    const jitterMs = Math.floor(Math.random() * 500);
    const delayMs = baseDelayMs + jitterMs;
    this.reconnectAttempts++;

    console.warn(
      `[ZMTP] Disconnected (${reason}). Reconnecting in ${(delayMs / 1000).toFixed(1)}s (attempt #${this.reconnectAttempts})...`,
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.running) {
        void this.connect();
      }
    }, delayMs);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
    this.lastDataTimestamp = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (!this.running) return;
      const idleMs = Date.now() - this.lastDataTimestamp;
      if (idleMs > this.idleTimeoutMs) {
        this.scheduleReconnect(`idle timeout after ${Math.round(idleMs / 1000)}s`);
      }
    }, 5_000);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const { hostname, port } = parseZmqTcpEndpoint(this.url);

    let greetingReceived = false;
    let rxBuffer: Buffer = Buffer.alloc(0);

    try {
      console.log(`[ZMTP] Connecting to EDDN relay at tcp://${hostname}:${port}...`);

      this.socket = await Bun.connect({
        hostname,
        port,
        socket: {
          open: (sock) => {
            this.lastDataTimestamp = Date.now();
            this.startWatchdog();
            sock.write(createZmtpGreeting());
          },
          data: (sock, chunk) => {
            this.lastDataTimestamp = Date.now();
            rxBuffer =
              rxBuffer.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([rxBuffer, Buffer.from(chunk)]);

            if (!greetingReceived) {
              if (rxBuffer.length < 64) {
                return;
              }
              const peerGreeting = rxBuffer.subarray(0, 64);
              if (peerGreeting[0] !== 0xff || (peerGreeting[10] ?? 0) < 0x03) {
                this.scheduleReconnect("invalid ZMTP 3.0 peer greeting");
                return;
              }

              greetingReceived = true;
              this.reconnectAttempts = 0;
              rxBuffer = Buffer.from(rxBuffer.subarray(64));

              sock.write(createZmtpSubHandshake());
              console.log(`[ZMTP] Handshake complete. Subscribed to tcp://${hostname}:${port}`);
            }

            try {
              const { frames, remainder } = parseZmtpFrames(rxBuffer);
              rxBuffer = remainder;

              for (const frame of frames) {
                if (frame.isCommand) {
                  const reply = handleZmtpCommandFrame(frame.body);
                  if (reply) {
                    sock.write(reply);
                  }
                  continue;
                }

                if (frame.body.length === 0) {
                  continue;
                }

                try {
                  const envelope = decodeEddnPayload(frame.body);
                  Promise.resolve(this.onMessage(envelope)).catch((err) => {
                    this.onError?.(err instanceof Error ? err : new Error(String(err)));
                  });
                } catch (decodeErr) {
                  this.onError?.(
                    decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr)),
                  );
                }
              }
            } catch (frameErr) {
              this.onError?.(frameErr instanceof Error ? frameErr : new Error(String(frameErr)));
              this.scheduleReconnect("frame parse error");
            }
          },
          close: () => {
            if (this.running) {
              this.scheduleReconnect("socket closed by remote");
            }
          },
          error: (_sock, err) => {
            this.onError?.(err);
            if (this.running) {
              this.scheduleReconnect(`socket error: ${err.message}`);
            }
          },
          connectError: (_sock, err) => {
            this.onError?.(err);
            if (this.running) {
              this.scheduleReconnect(`connect error: ${err.message}`);
            }
          },
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
      this.scheduleReconnect(`connection exception: ${error.message}`);
    }
  }
}
