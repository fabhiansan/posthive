import { ByteBuffer } from "kiwi-schema";
import { FIG_LIMITS, fail } from "./limits.js";

export interface DecodeMetrics {
  arrayItems: number;
  operations: number;
  invocations: number;
  maxDepth: number;
}

export interface GuardedDecoder {
  decodeMessage(bytes: Uint8Array): unknown;
  metrics(): DecodeMetrics;
}

/** Every generated decoder (including nested calls resolved through `this`) runs inside these budgets. */
export function createGuardedDecoder(source: string): GuardedDecoder {
  const budget: DecodeMetrics = { arrayItems: 0, operations: 0, invocations: 0, maxDepth: 0 };
  let depth = 0;

  class GuardedByteBuffer extends ByteBuffer {
    constructor(data?: Uint8Array) {
      super(data);
    }
    private operation(): void {
      if (++budget.operations > FIG_LIMITS.decodeOps) fail("FIG_LIMIT");
    }
    override readByte(): number { this.operation(); return super.readByte(); }
    override readByteArray(): Uint8Array { this.operation(); return super.readByteArray(); }
    override readVarFloat(): number { this.operation(); return super.readVarFloat(); }
    override readVarUint(): number { this.operation(); return super.readVarUint(); }
    override readVarInt(): number { this.operation(); return super.readVarInt(); }
    override readVarUint64(): bigint { this.operation(); return super.readVarUint64(); }
    override readVarInt64(): bigint { this.operation(); return super.readVarInt64(); }
    override readString(): string { this.operation(); return super.readString(); }
  }

  function GuardedArray(length: number): unknown[] {
    if (!Number.isSafeInteger(length) || length < 0 || length > FIG_LIMITS.arrayItems || budget.arrayItems + length > FIG_LIMITS.totalItems) fail("FIG_LIMIT");
    budget.arrayItems += length;
    return new Array(length);
  }

  const compiled: Record<string, unknown> = { ByteBuffer: GuardedByteBuffer };
  const execute = new Function("exports", "Array", "require", source) as (exports: Record<string, unknown>, array: typeof GuardedArray, require: (id: string) => never) => void;
  execute(compiled, GuardedArray, () => { throw new Error("require is disabled"); });

  for (const key of Object.keys(compiled)) {
    if (!key.startsWith("decode") || typeof compiled[key] !== "function") continue;
    const original = compiled[key] as (this: unknown, bb: Uint8Array) => unknown;
    compiled[key] = function guardedDecode(this: unknown, bb: Uint8Array): unknown {
      if (++budget.invocations > FIG_LIMITS.decodeInvocations) fail("FIG_LIMIT");
      if (++depth > FIG_LIMITS.decodeDepth) fail("FIG_LIMIT");
      budget.maxDepth = Math.max(budget.maxDepth, depth);
      try {
        return original.call(this, bb); // kiwi resolves nested decoders through `this`; losing it loses every guard
      } finally {
        depth--;
      }
    };
  }

  const decodeMessage = compiled.decodeMessage;
  if (typeof decodeMessage !== "function") fail("FIG_INVALID");
  return {
    decodeMessage(bytes: Uint8Array): unknown {
      budget.arrayItems = budget.operations = budget.invocations = budget.maxDepth = 0;
      depth = 0;
      return (decodeMessage as (bb: Uint8Array) => unknown).call(compiled, bytes);
    },
    metrics: () => ({ ...budget }),
  };
}
