// Canvas asset import: the SVG allowlist, the PNG checks and the rasterizer. SVG samples are small synthetic
// strings modeled on common exports (Figma, Illustrator, Inkscape); no real design files are used.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AssetRejected, allowUploadPath, processAsset, sanitizeSvg } from "./canvasAssets.js";

const NS = `xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`;
const svg = (inner: string, attrs = `width="100" height="50" viewBox="0 0 100 50"`) => `<svg ${NS} ${attrs}>${inner}</svg>`;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const dataPng = `data:image/png;base64,${Buffer.concat([PNG_MAGIC, Buffer.from("tail")]).toString("base64")}`;

/** The message of the rejection, or fail the test when the SVG was accepted. */
function rejection(source: string): string {
  try {
    sanitizeSvg(source);
  } catch (err) {
    expect(err).toBeInstanceOf(AssetRejected);
    return (err as Error).message;
  }
  throw new Error("expected the SVG to be rejected");
}

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#ff5c00" } }).png().toBuffer();

describe("SVG rejects", () => {
  it("a DOCTYPE, including an ENTITY", () => {
    expect(rejection(`<!DOCTYPE svg [<!ENTITY x "y">]>${svg(`<text>&x;</text>`)}`)).toMatch(/DOCTYPE/);
  });
  it("a processing instruction other than the XML declaration", () => {
    expect(rejection(`<?xml version="1.0"?><?xml-stylesheet href="a.css"?>${svg("")}`)).toMatch(/processing instruction/);
  });
  it("a root that is not <svg>", () => {
    expect(rejection(`<html xmlns="http://www.w3.org/1999/xhtml"/>`)).toMatch(/not an SVG/);
  });
  it.each([
    ["script", `<script>alert(1)</script>`],
    ["foreignObject", `<foreignObject width="10" height="10"/>`],
    ["style", `<style>rect{fill:red}</style>`],
    ["iframe", `<iframe/>`],
    ["animate", `<animate attributeName="x" to="1"/>`],
    ["feImage", `<filter id="f"><feImage/></filter>`],
    ["a", `<a href="#x"><rect width="1" height="1"/></a>`],
  ])("<%s>, naming it", (name, inner) => {
    expect(rejection(svg(inner))).toContain(`<${name}>`);
  });
  it("a style attribute, naming it", () => {
    expect(rejection(svg(`<rect width="10" height="10" style="fill:red"/>`))).toMatch(/attribute style/);
  });
  it("on* handlers and unknown attributes, naming them", () => {
    expect(rejection(svg(`<rect width="1" height="1" onload="alert(1)"/>`))).toMatch(/attribute onload/);
    expect(rejection(svg(`<rect width="1" height="1" data-x="1"/>`))).toMatch(/attribute data-x/);
    expect(rejection(svg(`<rect width="1" height="1" mix-blend-mode="multiply"/>`))).toMatch(/mix-blend-mode/);
  });
  it.each(["javascript:alert(1)", "http://evil.example/a.svg#x", "//evil.example/a", "../a.svg#x", "file:///etc/passwd", "data:text/html;base64,PGI+"])(
    "a reference to %s",
    (href) => {
      expect(rejection(svg(`<use xlink:href="${href}"/>`))).toMatch(/outside the file/);
      expect(rejection(svg(`<use href="${href}"/>`))).toMatch(/outside the file/);
    },
  );
  it("an external URL in a paint, clip-path or filter", () => {
    expect(rejection(svg(`<rect width="1" height="1" fill="url(http://evil.example/x)"/>`))).toMatch(/attribute fill/);
    expect(rejection(svg(`<rect width="1" height="1" clip-path="url(//evil.example/x)"/>`))).toMatch(/attribute clip-path/);
    expect(rejection(svg(`<rect width="1" height="1" filter="url(#a) url(#b)"/>`))).toMatch(/attribute filter/);
  });
  it("an unknown element, an extra namespace and editor-looking elements outside the editor namespaces", () => {
    expect(rejection(svg(`<marker id="m"/>`))).toContain("<marker>");
    expect(rejection(`<svg ${NS} xmlns:evil="http://evil.example/ns" width="1" height="1"/>`)).toMatch(/namespace/);
    expect(rejection(svg(`<evil:thing xmlns:evil="http://evil.example/ns"/>`))).toContain("<evil:thing>");
  });
  it.each([
    ["path data", `<path d="M0 0 alert(1)"/>`, /attribute d/],
    ["transform", `<g transform="scale(1) foo"/>`, /attribute transform/],
    ["transform arity", `<g transform="matrix(1 2 3)"/>`, /attribute transform/],
    ["paint", `<rect width="1" height="1" fill="red;stroke:blue"/>`, /attribute fill/],
    ["enum", `<rect width="1" height="1" fill-rule="bogus"/>`, /attribute fill-rule/],
    ["length", `<rect width="1e9" height="1"/>`, /attribute width/],
    ["id", `<rect id="a b" width="1" height="1"/>`, /attribute id/],
    ["stdDeviation", `<filter id="f"><feGaussianBlur stdDeviation="500"/></filter>`, /attribute stdDeviation/],
    ["font-family", `<text font-family="a;b">x</text>`, /attribute font-family/],
  ])("a bad %s value", (_what, inner, message) => {
    expect(rejection(svg(inner))).toMatch(message);
  });
  it("a duplicate id", () => {
    expect(rejection(svg(`<g id="a"/><g id="a"/>`))).toMatch(/more than once/);
  });
  it("text directly inside a shape", () => {
    expect(rejection(svg(`<g>hello</g>`))).toMatch(/text directly inside/);
  });
  it("a missing size", () => {
    expect(rejection(`<svg ${NS}/>`)).toMatch(/no size/);
  });
  it("invalid XML", () => {
    expect(rejection(svg(`<g></rect>`))).toMatch(/not valid XML/);
    expect(rejection(svg(`<text>&nbsp;</text>`))).toMatch(/not valid XML/);
  });
  it("depth, element and <use> limits", () => {
    expect(rejection(svg("<g>".repeat(70) + "</g>".repeat(70)))).toMatch(/levels deep/);
    expect(rejection(svg(`<rect width="1" height="1"/>`.repeat(10_001)))).toMatch(/more than 10000 elements/);
    expect(rejection(svg(`<g id="a"/>` + `<use href="#a"/>`.repeat(101)))).toMatch(/more than 100 <use>/);
  });
  it("<use> elements that loop or fan out through nesting", () => {
    expect(rejection(svg(`<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>`))).toMatch(/loop/);
    expect(rejection(svg(`<use id="a" href="#a"/>`))).toMatch(/loop/);

    // Five levels of ten <use> each (51 in all, under the cap of 100) would still expand to ~300,000 elements.
    const levels = ["b", "c", "d", "e", "f"];
    let tower = `<g id="a"><rect width="1" height="1"/></g>`;
    levels.forEach((id, i) => {
      const below = i === 0 ? "a" : levels[i - 1];
      tower += `<g id="${id}">${`<use href="#${below}"/>`.repeat(10)}</g>`;
    });
    expect(rejection(svg(`${tower}<use href="#f"/>`))).toMatch(/too many times/);
  });
  it("a fake PNG or JPEG in a data URI", () => {
    const html = `data:image/png;base64,${Buffer.from("<html><script>alert(1)</script>").toString("base64")}`;
    expect(rejection(svg(`<image width="1" height="1" xlink:href="${html}"/>`))).toMatch(/outside the file/);
    const gif = `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`;
    expect(rejection(svg(`<image width="1" height="1" href="${gif}"/>`))).toMatch(/outside the file/);
    // data: is accepted on <image> only
    expect(rejection(svg(`<use href="${dataPng}"/>`))).toMatch(/outside the file/);
  });
});

describe("SVG accepts", () => {
  it("a #id reference", () => {
    const out = sanitizeSvg(svg(`<defs><g id="g"><rect width="10" height="10"/></g></defs><use xlink:href="#g" x="5"/><use href="#g"/>`));
    expect(out.svg).toContain(`xlink:href="#g"`);
  });
  it("an element with both href and xlink:href keeps one, so the output is valid XML", () => {
    const out = sanitizeSvg(svg(`<defs><g id="a"/></defs><use href="#a" xlink:href="#a"/>`)).svg;
    expect(out.match(/xlink:href=/g)).toHaveLength(1);
    expect(sanitizeSvg(out).svg).toBe(out);
  });
  it("a real PNG data URI on <image>", () => {
    const out = sanitizeSvg(svg(`<image width="10" height="10" xlink:href="${dataPng}"/>`));
    expect(out.embedded).toHaveLength(1);
    expect(out.embedded[0].kind).toBe("png");
  });
  it("a Figma-style export: shapes, clipPath, drop-shadow filter, gradient, pattern with an image", async () => {
    const figma = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" ${NS}>
      <g clip-path="url(#clip0_1_2)">
        <rect width="24" height="24" fill="white"/>
        <path d="M12 2L2 7l10 5 10-5-10-5z" fill="#FF5C00" fill-opacity="0.8" fill-rule="evenodd"/>
        <g filter="url(#filter0_d_1_2)"><circle cx="12" cy="12" r="4" fill="url(#paint0_linear_1_2)"/></g>
        <rect x="2" y="2" width="8" height="8" fill="url(#pattern0)" stroke="rgba(0, 0, 0, 0.5)" stroke-linecap="round"/>
        <text x="2" y="20" font-family="Inter, 'Helvetica Neue'" font-size="4" font-weight="600" fill="#282202">Posthive &amp; co</text>
      </g>
      <defs>
        <filter id="filter0_d_1_2" x="0" y="0" width="24" height="24" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
          <feOffset dy="4"/><feGaussianBlur stdDeviation="2"/>
          <feComposite in2="hardAlpha" operator="out"/>
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1_2"/>
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_1_2" result="shape"/>
        </filter>
        <linearGradient id="paint0_linear_1_2" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FF5C00"/><stop offset="1" stop-color="#FFC700"/>
        </linearGradient>
        <clipPath id="clip0_1_2"><rect width="24" height="24" fill="white"/></clipPath>
        <pattern id="pattern0" patternContentUnits="objectBoundingBox" width="1" height="1">
          <use xlink:href="#image0" transform="scale(0.01)"/>
        </pattern>
        <image id="image0" width="100" height="100" xlink:href="${dataPng}"/>
      </defs>
    </svg>`;
    const out = sanitizeSvg(figma);
    expect(out.width).toBe(24);
    expect(out.height).toBe(24);
    expect(out.svg).toContain("<feGaussianBlur");
    expect(out.svg).toContain("<clipPath");
    expect(out.svg).toContain("Posthive &amp; co");
    expect(out.embedded).toHaveLength(1);

    // What the sanitizer lets through must also draw: the sample's data: image is a stub, so swap in a real PNG.
    const real = `data:image/png;base64,${(await png(16, 16)).toString("base64")}`;
    await expect(processAsset(Buffer.from(figma.replace(dataPng, real)))).resolves.toMatchObject({ sourceFormat: "svg" });
  });
  it("sizes from the viewBox when width and height are missing, and from one side when only one is given", () => {
    expect(sanitizeSvg(`<svg ${NS} viewBox="0 0 200 100"/>`)).toMatchObject({ width: 200, height: 100 });
    expect(sanitizeSvg(`<svg ${NS} width="50" viewBox="0 0 200 100"/>`)).toMatchObject({ width: 50, height: 25 });
  });
});

describe("SVG Figma/Illustrator/Inkscape patterns that v1 rejects", () => {
  it("mask-type:alpha (a style attribute)", () => {
    expect(rejection(svg(`<mask id="m" style="mask-type:alpha"><rect width="1" height="1"/></mask>`))).toMatch(/attribute style on <mask>/);
  });
  it("a CSS blend mode (a style attribute)", () => {
    expect(rejection(svg(`<g style="mix-blend-mode:multiply"><rect width="1" height="1"/></g>`))).toMatch(/attribute style on <g>/);
  });
  it("background blur through <foreignObject>", () => {
    expect(rejection(svg(`<foreignObject x="0" y="0" width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>`))).toContain("<foreignObject>");
  });
  it("Illustrator's default <style> classes", () => {
    expect(rejection(svg(`<style>.st0{fill:#FF0000}</style><rect class="st0" width="1" height="1"/>`))).toContain("<style>");
  });
  it("the error tells the user how to fix it", () => {
    expect(rejection(svg(`<style/>`))).toMatch(/presentation attributes|PNG/);
  });
});

describe("SVG output", () => {
  it("drops inert editor metadata with its subtree, and keeps the drawing", () => {
    const inkscape = `<svg ${NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="10" height="10" inkscape:version="1.2" sodipodi:docname="a.svg">
      <sodipodi:namedview id="base" inkscape:zoom="1"><inkscape:grid id="g"/></sodipodi:namedview>
      <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">x</dc:title></rdf:RDF></metadata>
      <rect inkscape:label="Layer" width="10" height="10" fill="#fff"/>
    </svg>`;
    const { svg: out } = sanitizeSvg(inkscape);
    expect(out).not.toMatch(/inkscape|sodipodi|metadata|rdf|dc:|namedview/i);
    expect(out).toContain(`<rect width="10" height="10" fill="#fff"/>`);
  });
  it("is rebuilt from the allowed tree only: nothing from the source leaks through, and it checks clean again", () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?><!-- <script>alert(1)</script> --><svg ${NS} width="10" height="10"><text x="1" y="1">&lt;script&gt;alert(1)&lt;/script&gt;<![CDATA[<b>]]></text><title>t</title></svg>`;
    const first = sanitizeSvg(source);
    expect(first.svg).not.toContain("<script");
    expect(first.svg).not.toContain("<!--");
    expect(first.svg).not.toContain("<?xml");
    expect(first.svg).not.toContain("CDATA");
    expect(first.svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;");
    expect(sanitizeSvg(first.svg).svg).toBe(first.svg);
  });
  it("escapes attribute values (font-family may hold a quote; class may not)", () => {
    const out = sanitizeSvg(svg(`<text font-family="a&quot;b">x</text>`)).svg;
    expect(out).toContain(`font-family="a&quot;b"`);
    expect(rejection(svg(`<g class="a&quot;b"/>`))).toMatch(/attribute class/);
  });
});

describe("processAsset", () => {
  it("rejects anything that is not a PNG or an SVG, whatever it is called", async () => {
    await expect(processAsset(Buffer.from("not an image"))).rejects.toThrow(/Only PNG and SVG/);
    await expect(processAsset(Buffer.from("GIF89a\x01\x00\x01\x00"))).rejects.toThrow(/Only PNG and SVG/);
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    await expect(processAsset(jpeg)).rejects.toThrow(/Only PNG and SVG/);
    await expect(processAsset(Buffer.alloc(0))).rejects.toBeInstanceOf(AssetRejected);
  });
  it("rejects a file with a PNG signature that is not a PNG", async () => {
    await expect(processAsset(Buffer.concat([PNG_MAGIC, Buffer.from("garbage garbage garbage")]))).rejects.toThrow(/could not be read/);
  });
  it("re-encodes a PNG: dimensions kept, trailing bytes dropped", async () => {
    const original = await png(20, 10);
    const out = await processAsset(Buffer.concat([original, Buffer.from("<script>alert(1)</script>")]));
    expect(out).toMatchObject({ width: 20, height: 10, sourceFormat: "png" });
    expect(out.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(out.png.includes(Buffer.from("<script>"))).toBe(false);
  });
  it("rejects a PNG over 8192px on a side", async () => {
    await expect(processAsset(await png(8200, 2))).rejects.toThrow(/8192px/);
  });
  it("rasterizes a clean SVG to a PNG, 3072px on the long edge", async () => {
    const out = await processAsset(Buffer.from(svg(`<rect width="100" height="50" fill="#FF5C00"/>`)));
    expect(out.sourceFormat).toBe("svg");
    expect(out.png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(Math.max(out.width, out.height)).toBe(3072);
    expect(out.height).toBe(1536);
  });
  it("a very small SVG stops at the density cap (4800), so it cannot reach 3072px", async () => {
    // 72 * 3072 / 40 would be 5530 dpi; the cap holds it to 4800, and the result is not upscaled past that.
    const out = await processAsset(Buffer.from(svg(`<rect width="40" height="20"/>`, `width="40" height="20"`)));
    expect(out).toMatchObject({ width: 2667, height: 1333 });
  });
  it("accepts a UTF-8 BOM and rejects invalid UTF-8 and gzip", async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(svg(`<rect width="10" height="10"/>`))]);
    await expect(processAsset(withBom)).resolves.toMatchObject({ sourceFormat: "svg" });
    await expect(processAsset(Buffer.concat([Buffer.from("<svg"), Buffer.from([0xff, 0xfe, 0xfd])]))).rejects.toThrow(/UTF-8/);
    await expect(processAsset(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).rejects.toThrow(/svgz/);
  });
  it("rejects an SVG over 1 MB", async () => {
    const big = svg(`<title>${"a".repeat(1_100_000)}</title>`);
    await expect(processAsset(Buffer.from(big))).rejects.toThrow(/larger than 1 MB/);
  });
  it("rejects an SVG whose embedded image decodes to a huge bitmap", async () => {
    const wide = `data:image/png;base64,${(await png(8300, 4)).toString("base64")}`;
    await expect(processAsset(Buffer.from(svg(`<image width="10" height="10" href="${wide}"/>`)))).rejects.toThrow(/embedded in the SVG is too large/);
  });
  it("draws an embedded image that is within limits", async () => {
    const ok = `data:image/png;base64,${(await png(16, 16)).toString("base64")}`;
    await expect(processAsset(Buffer.from(svg(`<image width="100" height="50" href="${ok}"/>`)))).resolves.toMatchObject({ sourceFormat: "svg" });
  });
});

describe("allowUploadPath", () => {
  it.each([
    "/.canvas-private/ws/a.png",
    "/.CANVAS-PRIVATE/ws/a.png",
    "/.Canvas-Private/ws/a.png",
    "/x/../.canvas-private/ws/a.png",
    "/.canvas-private./ws/a.png",
    "/.canvas-private /ws/a.png",
    "/.canvas-private\\ws\\a.png",
    "\\.canvas-private\\a.png",
    "//.canvas-private//a.png",
  ])("refuses %s", (p) => {
    expect(allowUploadPath(p)).toBe(false);
  });
  it.each(["/a.png", "/profile-pics/x.jpg", "/canvas-private/a.png", "/.canvas-private-not/a.png", "/a/.canvas/b.png"])("serves %s", (p) => {
    expect(allowUploadPath(p)).toBe(true);
  });
});
