/**
 * Minimal Clarity value decoder.
 *
 * `/v2/contracts/call-read` returns results as a hex-serialised Clarity value
 * and nothing else — no `repr`, no JSON. The Legion read path needs a handful
 * of those (brief status, vote tallies, heights, treasury balance), so rather
 * than pull in the full Stacks SDK for four call sites we decode the wire
 * format directly. It is small and stable.
 *
 * Scope note: principals are deliberately left as raw hex. Rendering one as a
 * `ST…` address requires c32check encoding, and the only principal the UI
 * needs (a brief's proposer) already arrives as a decoded string on the
 * chainhook event payload. Decoding it twice, in two formats, would mean
 * hand-rolling an address encoder to serve a field we already have — so the
 * read path carries the hex and the event path supplies the address.
 *
 * Reference: SIP-005 Clarity value serialisation.
 */

export type ClarityValue =
  | { type: "uint"; value: bigint }
  | { type: "int"; value: bigint }
  | { type: "bool"; value: boolean }
  | { type: "none" }
  | { type: "some"; value: ClarityValue }
  | { type: "ok"; value: ClarityValue }
  | { type: "err"; value: ClarityValue }
  | { type: "buffer"; hex: string }
  | { type: "string"; value: string }
  | { type: "list"; values: ClarityValue[] }
  | { type: "tuple"; data: Record<string, ClarityValue> }
  | { type: "principal"; hex: string };

const TYPE_INT = 0x00;
const TYPE_UINT = 0x01;
const TYPE_BUFFER = 0x02;
const TYPE_TRUE = 0x03;
const TYPE_FALSE = 0x04;
const TYPE_PRINCIPAL_STANDARD = 0x05;
const TYPE_PRINCIPAL_CONTRACT = 0x06;
const TYPE_OK = 0x07;
const TYPE_ERR = 0x08;
const TYPE_NONE = 0x09;
const TYPE_SOME = 0x0a;
const TYPE_LIST = 0x0b;
const TYPE_TUPLE = 0x0c;
const TYPE_STRING_ASCII = 0x0d;
const TYPE_STRING_UTF8 = 0x0e;

export class ClarityDecodeError extends Error {}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get consumed(): number {
    return this.offset;
  }

  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) {
      throw new ClarityDecodeError(
        `truncated value: wanted ${n} bytes at offset ${this.offset}, have ${this.bytes.length - this.offset}`
      );
    }
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  u8(): number {
    return this.take(1)[0];
  }

  /** Big-endian u32 length prefix, used by buffers, strings, lists and tuples. */
  u32(): number {
    const b = this.take(4);
    // Shift-based assembly overflows into negatives at the high bit; multiply instead.
    return b[0] * 0x1000000 + ((b[1] << 16) | (b[2] << 8) | b[3]);
  }

  /** Big-endian unsigned integer of `n` bytes. */
  uintBE(n: number): bigint {
    let out = 0n;
    for (const byte of this.take(n)) out = (out << 8n) | BigInt(byte);
    return out;
  }

  /** Big-endian two's-complement signed integer of `n` bytes. */
  intBE(n: number): bigint {
    const magnitude = this.uintBE(n);
    const signBit = 1n << BigInt(n * 8 - 1);
    return magnitude >= signBit ? magnitude - (signBit << 1n) : magnitude;
  }

  hex(n: number): string {
    return bytesToHex(this.take(n));
  }

  ascii(n: number): string {
    return new TextDecoder("ascii").decode(this.take(n));
  }

  utf8(n: number): string {
    return new TextDecoder("utf-8").decode(this.take(n));
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new ClarityDecodeError(`odd-length hex string (${clean.length} chars)`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new ClarityDecodeError(`invalid hex at byte ${i}`);
    }
    out[i] = byte;
  }
  return out;
}

function readValue(r: Reader): ClarityValue {
  const tag = r.u8();
  switch (tag) {
    case TYPE_INT:
      return { type: "int", value: r.intBE(16) };
    case TYPE_UINT:
      return { type: "uint", value: r.uintBE(16) };
    case TYPE_BUFFER:
      return { type: "buffer", hex: r.hex(r.u32()) };
    case TYPE_TRUE:
      return { type: "bool", value: true };
    case TYPE_FALSE:
      return { type: "bool", value: false };
    case TYPE_PRINCIPAL_STANDARD:
      // 1 version byte + 20-byte hash160.
      return { type: "principal", hex: r.hex(21) };
    case TYPE_PRINCIPAL_CONTRACT: {
      const base = r.hex(21);
      const nameLen = r.u8();
      return { type: "principal", hex: `${base}.${r.ascii(nameLen)}` };
    }
    case TYPE_OK:
      return { type: "ok", value: readValue(r) };
    case TYPE_ERR:
      return { type: "err", value: readValue(r) };
    case TYPE_NONE:
      return { type: "none" };
    case TYPE_SOME:
      return { type: "some", value: readValue(r) };
    case TYPE_LIST: {
      const len = r.u32();
      const values: ClarityValue[] = [];
      for (let i = 0; i < len; i++) values.push(readValue(r));
      return { type: "list", values };
    }
    case TYPE_TUPLE: {
      const len = r.u32();
      const data: Record<string, ClarityValue> = {};
      for (let i = 0; i < len; i++) {
        const key = r.ascii(r.u8());
        data[key] = readValue(r);
      }
      return { type: "tuple", data };
    }
    case TYPE_STRING_ASCII:
      return { type: "string", value: r.ascii(r.u32()) };
    case TYPE_STRING_UTF8:
      return { type: "string", value: r.utf8(r.u32()) };
    default:
      throw new ClarityDecodeError(`unknown Clarity type byte 0x${tag.toString(16).padStart(2, "0")}`);
  }
}

/** Decode a hex-serialised Clarity value. Trailing bytes are an error, not ignored. */
export function decodeClarityHex(hex: string): ClarityValue {
  const bytes = hexToBytes(hex);
  const reader = new Reader(bytes);
  const value = readValue(reader);
  if (reader.consumed !== bytes.length) {
    throw new ClarityDecodeError(
      `trailing bytes: consumed ${reader.consumed} of ${bytes.length}`
    );
  }
  return value;
}

// ── Accessors ──
//
// Read-only results arrive wrapped — usually `(optional ...)`, sometimes
// `(response ...)`. These unwrap without forcing every call site to switch on
// the tag union.

/** Unwrap `(some x)` to `x` and `none` to null. Passes other values through. */
export function unwrapOptional(value: ClarityValue): ClarityValue | null {
  if (value.type === "none") return null;
  if (value.type === "some") return value.value;
  return value;
}

/** Unwrap `(ok x)`. Throws on `(err ...)` so a failed call never reads as data. */
export function unwrapResponse(value: ClarityValue): ClarityValue {
  if (value.type === "err") {
    throw new ClarityDecodeError(`contract returned err: ${JSON.stringify(toJSON(value.value))}`);
  }
  if (value.type === "ok") return value.value;
  return value;
}

/**
 * Narrow a uint/int to a JS number.
 *
 * Clarity integers are 128-bit; every field the Legion UI reads (heights,
 * sats, weights) is far below 2^53, but a value that somehow exceeds it would
 * silently lose precision, so reject rather than round.
 */
export function asNumber(value: ClarityValue | null | undefined): number {
  if (!value || (value.type !== "uint" && value.type !== "int")) {
    throw new ClarityDecodeError(`expected uint/int, got ${value?.type ?? "undefined"}`);
  }
  if (value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ClarityDecodeError(`integer ${value.value} exceeds safe range`);
  }
  return Number(value.value);
}

/** Read a field from a tuple, or null if absent / not a tuple. */
export function tupleField(value: ClarityValue | null, key: string): ClarityValue | null {
  if (!value || value.type !== "tuple") return null;
  return value.data[key] ?? null;
}

/** Plain-JSON projection for logging and API responses. Bigints become numbers. */
export function toJSON(value: ClarityValue): unknown {
  switch (value.type) {
    case "uint":
    case "int":
      return value.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value.value)
        : value.value.toString();
    case "bool":
      return value.value;
    case "none":
      return null;
    case "some":
    case "ok":
      return toJSON(value.value);
    case "err":
      return { err: toJSON(value.value) };
    case "buffer":
    case "principal":
      return value.hex;
    case "string":
      return value.value;
    case "list":
      return value.values.map(toJSON);
    case "tuple": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.data)) out[k] = toJSON(v);
      return out;
    }
  }
}
