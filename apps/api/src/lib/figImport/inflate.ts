import { Inflate } from "fflate";
import { Decompress } from "fzstd";
import { FIG_LIMITS, fail } from "./limits.js";

export interface BoundedInflateResult {
  bytes: Uint8Array;
  inputBytes: number;
  callbacks: number;
}

/**
 * fflate's callback size follows the input slice, not a fixed output quantum. Small input slices keep a
 * highly-compressible chunk from materialising its whole output before our cap gets a chance to run.
 */
export function inflateBounded(input: Uint8Array, maxOutput: number, onChunk?: (chunk: Uint8Array) => void): BoundedInflateResult {
  const output = new Uint8Array(maxOutput);
  let written = 0;
  let callbacks = 0;
  let final = false;
  const stream = new Inflate((chunk, isFinal) => {
    callbacks++;
    if (written + chunk.length > maxOutput) fail("FIG_LIMIT");
    const start = written;
    output.set(chunk, written);
    written += chunk.length;
    onChunk?.(output.subarray(start, written));
    final ||= isFinal;
  });
  for (let offset = 0; offset < input.length; offset += FIG_LIMITS.inputSliceBytes) {
    stream.push(input.subarray(offset, Math.min(offset + FIG_LIMITS.inputSliceBytes, input.length)), offset + FIG_LIMITS.inputSliceBytes >= input.length);
  }
  if (input.length === 0) stream.push(input, true);
  if (!final) fail("FIG_INVALID");
  return { bytes: output.subarray(0, written), inputBytes: input.length, callbacks };
}

/** fzstd allocates its window from each frame header before ondata runs; reject oversized windows first. */
function validateZstdFrames(input: Uint8Array, maxOutput: number): void {
  let at = 0;
  while (at < input.length) {
    if (at + 5 > input.length || input[at] !== 0x28 || input[at + 1] !== 0xb5 || input[at + 2] !== 0x2f || input[at + 3] !== 0xfd) fail("FIG_INVALID");
    const descriptor = input[at + 4];
    const single = (descriptor >> 5) & 1;
    const contentFlag = descriptor >> 6;
    const dictionaryFlag = descriptor & 3;
    if (descriptor & 0x08 || dictionaryFlag !== 0) fail("FIG_INVALID");
    let cursor = at + 5;
    let window = 0;
    if (!single) {
      if (cursor >= input.length) fail("FIG_INVALID");
      const value = input[cursor++];
      const base = 2 ** (10 + (value >> 3));
      window = base + (base >> 3) * (value & 7);
    }
    cursor += [0, 1, 2, 4][dictionaryFlag];
    const sizeBytes = contentFlag === 0 ? (single ? 1 : 0) : 1 << contentFlag;
    if (cursor + sizeBytes > input.length) fail("FIG_INVALID");
    let contentSize = 0;
    for (let i = 0; i < sizeBytes; i++) contentSize += input[cursor + i] * 2 ** (8 * i);
    if (contentFlag === 1) contentSize += 256;
    cursor += sizeBytes;
    if (single) window = contentSize;
    if (!Number.isSafeInteger(window) || !Number.isSafeInteger(contentSize) || window > maxOutput || contentSize > maxOutput) fail("FIG_LIMIT");
    let declaredOutput = 0;
    for (;;) {
      if (cursor + 3 > input.length) fail("FIG_INVALID");
      const header = input[cursor] | (input[cursor + 1] << 8) | (input[cursor + 2] << 16);
      cursor += 3;
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      if (type === 3) fail("FIG_INVALID");
      if (type !== 2 && (declaredOutput += size) > maxOutput) fail("FIG_LIMIT");
      cursor += type === 1 ? 1 : size; // RLE blocks carry one input byte; raw/compressed carry `size`
      if (cursor > input.length) fail("FIG_INVALID");
      if (last) break;
    }
    if (descriptor & 4) cursor += 4; // content checksum
    if (cursor > input.length) fail("FIG_INVALID");
    at = cursor;
  }
}

export function zstdBounded(input: Uint8Array, maxOutput: number, onChunk?: (chunk: Uint8Array) => void): BoundedInflateResult {
  validateZstdFrames(input, maxOutput);
  const output = new Uint8Array(maxOutput);
  let written = 0;
  let callbacks = 0;
  let final = false;
  const stream = new Decompress((chunk, isFinal) => {
    callbacks++;
    if (written + chunk.length > maxOutput) fail("FIG_LIMIT");
    const start = written;
    output.set(chunk, written);
    written += chunk.length;
    onChunk?.(output.subarray(start, written));
    final ||= !!isFinal;
  });
  for (let offset = 0; offset < input.length; offset += FIG_LIMITS.inputSliceBytes) {
    stream.push(input.subarray(offset, Math.min(offset + FIG_LIMITS.inputSliceBytes, input.length)), offset + FIG_LIMITS.inputSliceBytes >= input.length);
  }
  if (input.length === 0) stream.push(input, true);
  if (!final) fail("FIG_INVALID");
  return { bytes: output.subarray(0, written), inputBytes: input.length, callbacks };
}
