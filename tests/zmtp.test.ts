import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  buildZmtpFrame,
  createZmtpGreeting,
  createZmtpSubHandshake,
  decodeEddnPayload,
  type EddnEnvelope,
  handleZmtpCommandFrame,
  parseZmtpFrames,
} from "../src/listener/zmtp-client.ts";

describe("ZMTP 3.0 Wire Protocol & EDDN Zlib Framing", () => {
  test("creates valid 64-byte ZMTP 3.0 NULL greeting and SUB handshake", () => {
    const greeting = createZmtpGreeting();
    expect(greeting.length).toBe(64);
    expect(greeting[0]).toBe(0xff);
    expect(greeting[10]).toBe(0x03);
    expect(greeting.subarray(12, 16).toString("ascii")).toBe("NULL");

    const handshake = createZmtpSubHandshake();
    expect(handshake.includes(Buffer.from("READY"))).toBe(true);
    expect(handshake.includes(Buffer.from("SUBSCRIBE"))).toBe(true);
  });

  test("parses short and long ZMTP frames across fragmented TCP chunks", () => {
    const shortPayload = Buffer.from("short-frame-payload", "utf8");
    const longPayload = Buffer.alloc(600, 0x42);

    const frame1 = buildZmtpFrame(shortPayload);
    const frame2 = buildZmtpFrame(longPayload);
    const combined = Buffer.concat([frame1, frame2]);

    // Split mid-way through frame2
    const chunkA = combined.subarray(0, frame1.length + 50);
    const chunkB = combined.subarray(frame1.length + 50);

    const step1 = parseZmtpFrames(chunkA);
    expect(step1.frames.length).toBe(1);
    expect(step1.frames[0]?.isLong).toBe(false);
    expect(step1.frames[0]?.body.toString("utf8")).toBe("short-frame-payload");
    expect(step1.remainder.length).toBe(50);

    const step2 = parseZmtpFrames(Buffer.concat([step1.remainder, chunkB]));
    expect(step2.frames.length).toBe(1);
    expect(step2.frames[0]?.isLong).toBe(true);
    expect(step2.frames[0]?.body.length).toBe(600);
    expect(step2.remainder.length).toBe(0);
  });

  test("responds to ZMTP PING command frame with matching PONG frame", () => {
    // PING command: [4, 'P','I','N','G', 0x00, 0x64, 'c','t','x']
    const pingBody = Buffer.from([0x04, 0x50, 0x49, 0x4e, 0x47, 0x00, 0x64, 0x63, 0x74, 0x78]);
    const pongFrame = handleZmtpCommandFrame(pingBody);
    expect(pongFrame).not.toBeNull();

    const parsed = parseZmtpFrames(pongFrame!);
    expect(parsed.frames.length).toBe(1);
    expect(parsed.frames[0]?.isCommand).toBe(true);
    expect(parsed.frames[0]?.body.toString("ascii")).toBe("\x04PONGctx");
  });

  test("decompresses and parses zlib-compressed EDDN JSON payload", () => {
    const sampleEnvelope: EddnEnvelope = {
      $schemaRef: "https://eddn.edcd.io/schemas/commodity/3",
      header: {
        uploaderID: "test-uploader",
        gameversion: "4.4.2.0",
        gatewayTimestamp: "2026-10-22T16:00:00Z",
      },
      message: {
        systemName: "Heverty",
        stationName: "Woodroffe Gateway",
        marketId: 3228765184,
      },
    };

    const compressed = deflateSync(Buffer.from(JSON.stringify(sampleEnvelope), "utf8"));
    const decoded = decodeEddnPayload(compressed);
    expect(decoded.$schemaRef).toBe(sampleEnvelope.$schemaRef);
    expect(decoded.message.systemName).toBe("Heverty");
    expect(decoded.message.stationName).toBe("Woodroffe Gateway");
  });
});
