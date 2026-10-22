import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma.js";
import { getWorkspaceId, getUser, withAuth } from "../lib/auth/withAuth.js";
import {
  CsvParseError,
  decodeUtf8,
} from "../lib/import/csv.js";
import {
  CsvHeaderError,
  MAX_IMPORT_BYTES,
  getTemplateCsv,
  parsePlanningCsv,
  type PlanningDuplicateRow,
  type PlanningRow,
} from "../lib/import/planningImport.js";

class ImportUploadError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "IMPORT_ERROR") {
    super(message);
    this.name = "ImportUploadError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface ImportUpload {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  sourceRows?: number[];
}

interface ImportAccount {
  id: string;
  platform: string;
  displayName: string;
}

interface ResolvedTarget {
  accountId: string;
  platform: string;
  displayName: string;
}

function parseSourceRows(raw: string): number[] {
  const value = raw.trim();
  if (!value) return [];

  let parsed: unknown;
  if (value.startsWith("[")) {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ImportUploadError("Field sourceRows harus berupa array angka.");
    }
  } else {
    parsed = value.split(",").map((part) => part.trim()).filter(Boolean);
  }

  if (!Array.isArray(parsed)) {
    throw new ImportUploadError("Field sourceRows harus berupa array angka.");
  }

  const rows = parsed.map((item) => Number(item));
  if (rows.some((row) => !Number.isInteger(row) || row < 1)) {
    throw new ImportUploadError("Field sourceRows harus berisi nomor baris positif.");
  }

  return [...new Set(rows)];
}

async function readUpload(req: FastifyRequest): Promise<ImportUpload> {
  if (!req.isMultipart()) {
    throw new ImportUploadError("Upload file CSV sebagai multipart/form-data dengan field 'file'.");
  }

  let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;
  let sourceRows: number[] | undefined;

  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file") {
        part.file.resume();
        continue;
      }
      if (file) {
        part.file.resume();
        throw new ImportUploadError("Hanya satu file CSV yang boleh diunggah.");
      }

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of part.file) {
        total += chunk.length;
        if (total > MAX_IMPORT_BYTES) {
          throw new ImportUploadError(
            `File terlalu besar. Maksimum ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
            413,
            "FILE_TOO_LARGE",
          );
        }
        chunks.push(chunk);
      }

      file = {
        buffer: Buffer.concat(chunks),
        filename: part.filename ?? "",
        mimetype: part.mimetype,
      };
      continue;
    }

    if (part.fieldname === "sourceRows") {
      sourceRows = parseSourceRows(String(part.value));
    }
  }

  if (!file) {
    throw new ImportUploadError("File CSV wajib diunggah pada field 'file'.");
  }

  const filename = file.filename.toLowerCase();
  if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) {
    throw new ImportUploadError(
      "File Excel (.xlsx/.xls) belum didukung. Export sheet ke CSV UTF-8 terlebih dahulu.",
      415,
      "UNSUPPORTED_FILE_TYPE",
    );
  }
  if (!filename.endsWith(".csv")) {
    throw new ImportUploadError(
      "Format file harus .csv. Export sheet marketing ke CSV UTF-8 terlebih dahulu.",
      415,
      "UNSUPPORTED_FILE_TYPE",
    );
  }

  return { ...file, sourceRows };
}

function resolveTargets(platforms: string[], accounts: ImportAccount[]): {
  targets: ResolvedTarget[];
  warnings: string[];
} {
  const targets: ResolvedTarget[] = [];
  const warnings: string[] = [];

  for (const platform of platforms) {
    if (platform === "website") continue;

    const matches = accounts.filter((account) => account.platform === platform);
    if (matches.length === 1) {
      const account = matches[0];
      targets.push({
        accountId: account.id,
        platform: account.platform,
        displayName: account.displayName,
      });
    } else if (matches.length === 0) {
      warnings.push(`Akun ${platform} belum terhubung; draft dibuat tanpa target.`);
    } else {
      warnings.push(
        `Ada ${matches.length} akun ${platform}; target tidak dipilih otomatis. Pilih akun manual sebelum scheduling.`,
      );
    }
  }

  return { targets, warnings };
}

function previewRow(row: PlanningRow, targets: ResolvedTarget[], targetWarnings: string[]) {
  return {
    sourceRow: row.sourceRow,
    importKey: row.importKey,
    title: row.title,
    postDate: row.postDate,
    scheduledFor: row.scheduledFor.toISOString(),
    platforms: row.platforms,
    platformLabel: row.platformLabel,
    sourceStatus: row.sourceStatus,
    pillar: row.pillar,
    category: row.category,
    picContent: row.picContent,
    reviewer: row.reviewer,
    picDesign: row.picDesign,
    progress: row.progress,
    outputUrl: row.outputUrl,
    assetNotes: row.assetNotes,
    designCopyPreview: row.designCopy.slice(0, 500),
    designCopyLength: row.designCopy.length,
    designCopyHasLineBreaks: row.designCopy.includes("\n") || row.designCopy.includes("\r"),
    targets,
    warnings: [...row.warnings, ...targetWarnings],
  };
}

async function prepareImport(workspaceId: string, req: FastifyRequest) {
  const upload = await readUpload(req);
  const text = decodeUtf8(upload.buffer);
  const parsed = parsePlanningCsv(text);

  const importKeys = parsed.rows.map((row) => row.importKey);
  const existing = importKeys.length > 0
    ? await prisma.postJob.findMany({
        where: { workspaceId, importKey: { in: importKeys } },
        select: { importKey: true },
      })
    : [];
  const existingKeys = new Set(existing.map((row) => row.importKey));

  const databaseDuplicates: PlanningDuplicateRow[] = parsed.rows
    .filter((row) => existingKeys.has(row.importKey))
    .map((row) => ({
      sourceRow: row.sourceRow,
      importKey: row.importKey,
      title: row.title,
      reason: "Sudah pernah diimpor ke workspace ini.",
    }));

  const rows = parsed.rows.filter((row) => !existingKeys.has(row.importKey));
  const duplicates = [...parsed.duplicates, ...databaseDuplicates];

  const accounts = await prisma.account.findMany({
    where: { workspaceId },
    select: { id: true, platform: true, displayName: true },
    orderBy: { createdAt: "asc" },
  });

  return { upload, parsed, rows, duplicates, accounts };
}

function importError(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof ImportUploadError) {
    return reply.status(error.statusCode).send({ error: error.message, code: error.code });
  }
  if (error instanceof CsvParseError || error instanceof CsvHeaderError) {
    return reply.status(400).send({ error: error.message, code: "INVALID_CSV" });
  }
  throw error;
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/jobs/import/template",
    { preHandler: [withAuth], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      return reply
        .header("Content-Disposition", 'attachment; filename="posthive-content-plan-template.csv"')
        .type("text/csv; charset=utf-8")
        .send(getTemplateCsv());
    },
  );

  app.post(
    "/jobs/import/preview",
    { preHandler: [withAuth], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const workspaceId = getWorkspaceId(req);

      try {
        const { upload, parsed, rows, duplicates, accounts } = await prepareImport(workspaceId, req);

        const previewRows = rows.map((row) => {
          const resolved = resolveTargets(row.platforms, accounts);
          return previewRow(row, resolved.targets, resolved.warnings);
        });

        return reply.send({
          file: {
            name: upload.filename,
            delimiter: parsed.delimiter,
            headerRow: parsed.header.headerRow,
            subHeaderRow: parsed.header.subHeaderRow,
          },
          summary: {
            totalRows: parsed.totalDataRows,
            validRows: previewRows.length,
            invalidRows: parsed.invalidRows.length,
            duplicateRows: duplicates.length,
          },
          rows: previewRows,
          invalidRows: parsed.invalidRows,
          duplicates,
        });
      } catch (error) {
        return importError(reply, error);
      }
    },
  );

  app.post(
    "/jobs/import/commit",
    { preHandler: [withAuth], config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { id: userId } = getUser(req);
      const workspaceId = getWorkspaceId(req);

      try {
        const { upload, parsed, rows, duplicates, accounts } = await prepareImport(workspaceId, req);
        const selectedRows = upload.sourceRows;

        if (selectedRows && selectedRows.length === 0) {
          throw new ImportUploadError("sourceRows tidak boleh kosong.");
        }
        const selected = selectedRows ? new Set(selectedRows) : null;

        const skipped: Array<{ sourceRow: number; reason: string }> = [];
        for (const invalid of parsed.invalidRows) {
          skipped.push({ sourceRow: invalid.sourceRow, reason: invalid.reason });
        }
        for (const duplicate of duplicates) {
          skipped.push({ sourceRow: duplicate.sourceRow, reason: duplicate.reason });
        }

        if (selected) {
          const knownRows = new Set<number>([
            ...parsed.rows.map((row) => row.sourceRow),
            ...parsed.invalidRows.map((row) => row.sourceRow),
            ...duplicates.map((row) => row.sourceRow),
          ]);
          for (const sourceRow of selected) {
            if (!knownRows.has(sourceRow)) {
              skipped.push({ sourceRow, reason: "Baris tidak ditemukan di file." });
            }
          }
        }

        const candidates = selected
          ? rows.filter((row) => selected.has(row.sourceRow))
          : rows;

        const created: Array<{
          id: string;
          sourceRow: number;
          title: string;
          scheduledFor: string;
        }> = [];

        for (const row of candidates) {
          const resolved = resolveTargets(row.platforms, accounts);
          const importedAt = new Date().toISOString();
          const content = {
            text: "",
            mediaUrls: [],
            title: row.title,
            designCopy: row.designCopy,
            designCopySource: "Link Copywrite",
            assetNotes: row.assetNotes,
            pillar: row.pillar,
            category: row.category,
            platforms: row.platforms,
            platformLabel: row.platformLabel,
            picContent: row.picContent,
            contentReview: row.contentReview,
            approvedBy: row.approvedBy,
            reviewer: row.reviewer,
            picDesign: row.picDesign,
            progress: row.progress,
            outputUrl: row.outputUrl,
            sourceStatus: row.sourceStatus,
            sourceRow: row.sourceRow,
            importSource: {
              fileName: upload.filename,
              importedAt,
              delimiter: parsed.delimiter,
            },
          };

          try {
            const job = await prisma.postJob.create({
              data: {
                scheduledFor: row.scheduledFor,
                status: "draft",
                content: JSON.stringify(content),
                commentText: null,
                dryRun: false,
                approvalStatus: null,
                userId,
                workspaceId,
                importKey: row.importKey,
                ...(resolved.targets.length > 0
                  ? { targets: { create: resolved.targets.map((target) => ({ accountId: target.accountId })) } }
                  : {}),
              },
              select: { id: true },
            });

            created.push({
              id: job.id,
              sourceRow: row.sourceRow,
              title: row.title,
              scheduledFor: row.scheduledFor.toISOString(),
            });
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              (error as { code?: unknown }).code === "P2002"
            ) {
              skipped.push({ sourceRow: row.sourceRow, reason: "Sudah pernah diimpor ke workspace ini." });
              continue;
            }
            throw error;
          }
        }

        return reply.status(created.length > 0 ? 201 : 200).send({
          summary: {
            totalRows: parsed.totalDataRows,
            selectedRows: selected ? selected.size : parsed.totalDataRows,
            created: created.length,
            skipped: skipped.length,
            invalidRows: parsed.invalidRows.length,
            duplicateRows: duplicates.length,
          },
          jobs: created,
          skipped,
        });
      } catch (error) {
        return importError(reply, error);
      }
    },
  );
}
