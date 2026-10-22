import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/lib/import/csv.js";
import {
  makeImportKey,
  parsePlanningCsv,
  parsePlatforms,
} from "../src/lib/import/planningImport.js";

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

test("CSV parser preserves commas, escaped quotes, and line breaks inside cells", () => {
  const csv = [
    "title,copy,date",
    `First,${quote('Slide 1: comma, quote "hello"\nSlide 2: next')},2026-10-22`,
  ].join("\r\n");

  const rows = parseCsv(csv);
  assert.equal(rows[0][0], "title");
  assert.equal(rows[1][0], "First");
  assert.equal(rows[1][1], 'Slide 1: comma, quote "hello"\nSlide 2: next');
  assert.equal(rows[1][2], "2026-10-22");
});

test("CSV parser supports semicolon-separated files", () => {
  const rows = parseCsv('title;copy\r\nFirst;"Hello; world"', ";");
  assert.deepEqual(rows[0], ["title", "copy"]);
  assert.deepEqual(rows[1], ["First", "Hello; world"]);
});

test("two-row client header is detected, designCopy and Caption are preserved", () => {
  const header1 = [
    "Category", "", "Content Title", "Link Copywrite", "Caption", "Aset Pendukung",
    "Post Date", "Platform", "PIC Content", "Content Review", "", "", "", "Status",
  ].join(",");
  const header2 = [
    "Content Pillar", "Content Category", "", "", "", "",
    "", "", "", "Acc by", "PIC Design", "Progress Content", "Link Output", "",
  ].join(",");
  const copy = 'Slide 1: line one, with comma\nSlide 2: quote "hello"';
  const caption = "Caption line one.\n\nCaption line two with a comma, and a quote \"hello\".";
  const data = [
    "Educational",
    "Geospatial Insight/Expertise",
    quote("When Environmental Data Leads to Enforcement"),
    quote(copy),
    quote(caption),
    "https://www.figma.com/design/example",
    "2026-01-27",
    "LinkedIn",
    "ICA",
    "Bang Jum",
    "Ka Yasin",
    "Finish Design",
    "https://www.figma.com/design/output",
    "Published",
  ].join(",");

  const parsed = parsePlanningCsv([header1, header2, data].join("\r\n"));

  assert.equal(parsed.header.headerRow, 1);
  assert.equal(parsed.header.subHeaderRow, 2);
  assert.equal(parsed.totalDataRows, 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].title, "When Environmental Data Leads to Enforcement");
  assert.equal(parsed.rows[0].designCopy, copy);
  assert.equal(parsed.rows[0].caption, caption);
  assert.equal(parsed.rows[0].postDate, "2026-01-27");
  assert.equal(parsed.rows[0].scheduledFor.toISOString(), "2026-01-27T02:00:00.000Z");
  assert.deepEqual(parsed.rows[0].platforms, ["linkedin"]);
  assert.equal(parsed.rows[0].pillar, "Educational");
  assert.equal(parsed.rows[0].category, "Geospatial Insight/Expertise");
  assert.equal(parsed.rows[0].reviewer, "Bang Jum");
  assert.equal(parsed.rows[0].picDesign, "Ka Yasin");
  assert.equal(parsed.rows[0].sourceStatus, "Published");
  assert.ok(parsed.rows[0].warnings.some((warning) => warning.includes("Published")));
});

test("Caption column is optional and leaves content text empty when absent", () => {
  const parsed = parsePlanningCsv(
    "Content Title,Link Copywrite,Post Date,Platform\nDesign only,Slide 1: draft,2026-10-22,LinkedIn",
  );

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].designCopy, "Slide 1: draft");
  assert.equal(parsed.rows[0].caption, "");
});

test("duplicate rows in one file are reported and skipped", () => {
  const header = "Content Title,Post Date,Platform";
  const row = "Same title,2026-10-22,LinkedIn";
  const parsed = parsePlanningCsv([header, row, row].join("\n"));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.duplicates.length, 1);
  assert.match(parsed.duplicates[0].reason, /Duplikat/);
});

test("website rows are valid but carry a publishing warning", () => {
  const parsed = parsePlanningCsv("Content Title,Post Date,Platform\nWebsite post,2026-10-22,Website");
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].platforms, ["website"]);
  assert.ok(parsed.rows[0].warnings.some((warning) => warning.includes("Website")));
});

test("invalid dates and platforms are reported with a useful reason", () => {
  const parsed = parsePlanningCsv(
    "Content Title,Post Date,Platform\nBad date,2026-02-31,LinkedIn\nBad platform,2026-10-22,MySpace",
  );

  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.invalidRows.length, 2);
  assert.match(parsed.invalidRows[0].reason, /Post Date tidak valid/);
  assert.match(parsed.invalidRows[1].reason, /Platform tidak dikenal/);
});

test("platform aliases and import keys are deterministic", () => {
  assert.deepEqual(parsePlatforms("Mirroring (LI&Ig)").platforms, ["linkedin", "instagram"]);
  assert.deepEqual(parsePlatforms("LinkedIn & Instagram").platforms, ["linkedin", "instagram"]);
  assert.deepEqual(parsePlatforms("Website").platforms, ["website"]);

  const first = makeImportKey("  Example   Title ", "2026-10-22", ["instagram", "linkedin"]);
  const second = makeImportKey("example title", "2026-10-22", ["linkedin", "instagram"]);
  assert.equal(first, second);
});

test("ambiguous slash dates default to day-first with a warning", () => {
  const parsed = parsePlanningCsv("Content Title,Post Date,Platform\nAmbiguous,01/02/2026,LinkedIn");
  assert.equal(parsed.rows[0].postDate, "2026-02-01");
  assert.ok(parsed.rows[0].warnings.some((warning) => warning.includes("DD/MM/YYYY")));
});
