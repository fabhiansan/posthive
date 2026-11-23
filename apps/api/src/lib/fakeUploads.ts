// A small in-memory stand-in for the Upload table and the reference scan, for tests of code that follows the media lock protocol
// (lib/mediaDelete.ts). It answers the two raw queries that module makes, in the order they are made, and records every Upload write.
// Test support only: nothing in the app imports it.

export interface FakeUpload {
  url: string;
  userId: string;
  claimedAt: Date | null;
}

export function fakeUploads(initial: FakeUpload[] = [], referenced: () => string[] = () => []) {
  const rows = new Map(initial.map((r) => [r.url, { ...r }]));
  const log: Array<{ fn: "lock" | "scan" | "updateMany" | "deleteMany"; args: unknown }> = [];

  /** The $queryRaw of a transaction client: the Upload lock (a SELECT ... FOR UPDATE) or the reference scan (unnest). */
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FOR UPDATE")) {
      const urls = values[0] as string[];
      log.push({ fn: "lock", args: urls });
      return urls.filter((u) => rows.has(u)).map((u) => ({ ...rows.get(u)! }));
    }
    if (text.includes("unnest")) {
      const urls = values[0] as string[];
      log.push({ fn: "scan", args: { urls, ignoreJobs: values[1] } });
      const used = new Set(referenced());
      return urls.filter((u) => used.has(u)).map((url) => ({ url }));
    }
    return [];
  };

  const upload = {
    updateMany: async (args: { where: { url: { in: string[] }; userId?: string; claimedAt?: null }; data: { claimedAt: Date } }) => {
      log.push({ fn: "updateMany", args });
      let count = 0;
      for (const u of args.where.url.in) {
        const r = rows.get(u);
        if (!r) continue;
        if (args.where.userId !== undefined && r.userId !== args.where.userId) continue;
        if (args.where.claimedAt === null && r.claimedAt !== null) continue;
        r.claimedAt = args.data.claimedAt;
        count++;
      }
      return { count };
    },
    deleteMany: async (args: { where: { url: { in: string[] } } }) => {
      log.push({ fn: "deleteMany", args });
      let count = 0;
      for (const u of args.where.url.in) if (rows.delete(u)) count++;
      return { count };
    },
    count: async (args: { where: { url: { in: string[] }; userId: string } }) =>
      args.where.url.in.filter((u) => rows.get(u)?.userId === args.where.userId).length,
  };

  return { rows, log, $queryRaw, upload, calls: (fn: string) => log.filter((l) => l.fn === fn) };
}
