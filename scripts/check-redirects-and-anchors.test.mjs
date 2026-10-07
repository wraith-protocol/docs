import test from "node:test";
import assert from "node:assert/strict";
import { extractAnchors, extractLinks, fileToUrl, getScanFiles, isExcludedLink, parseRenameRecords, resolveLink, validateLinkAnchor, validateRedirects, validateRenamedPageLink } from "./check-redirects-and-anchors.mjs";

test("only actual Git rename records for Markdown pages are selected", () => {
  assert.deepEqual(parseRenameRecords("R100\tREADME.mdx\tintroduction.mdx\nM\tdocs.json\nR090\told.txt\tnew.txt\nA\tnew.mdx\n"), [["README.mdx", "introduction.mdx"]]);
});

test("page paths map to root-relative extensionless URLs", () => {
  assert.equal(fileToUrl("README.mdx"), "/README");
  assert.equal(fileToUrl("docs/i18n.md"), "/docs/i18n");
  assert.equal(fileToUrl("guides/old-page.md"), "/guides/old-page");
});

test("extracts generated, duplicate, explicit, and HTML anchors", () => {
  const anchors = extractAnchors("## Getting Started\n## Getting Started\n## User guide {#custom-id}\n<a id=\"legacy\"></a>");
  for (const anchor of ["getting-started", "getting-started-1", "custom-id", "legacy"]) assert.ok(anchors.has(anchor), anchor);
});

test("finds Markdown and HTML internal links", () => {
  assert.deepEqual(extractLinks("[one](/guide#section) and <a href='/intro'>intro</a>"), ["/guide#section", "/intro"]);
});

test("resolves root-relative, relative, and page-local anchor links", () => {
  const pages = new Map([["/guide", "guide.mdx"], ["/intro", "intro.mdx"], ["/section/child", "section/child.mdx"], ["/docs/i18n", "docs/i18n.md"]]);
  assert.deepEqual(resolveLink("guide.mdx", "/intro#start", pages), { external: false, url: "/intro", anchor: "start", file: "intro.mdx" });
  assert.deepEqual(resolveLink("section/child.mdx", "../guide#part", pages), { external: false, url: "/guide", anchor: "part", file: "guide.mdx" });
  assert.deepEqual(resolveLink("guide.mdx", "#local", pages), { external: false, url: "/guide", anchor: "local", file: "guide.mdx" });
  assert.deepEqual(resolveLink("guide.mdx", "/docs/i18n.md#language-note", pages), { external: false, url: "/docs/i18n", anchor: "language-note", file: "docs/i18n.md" });
});

test("requires an exact redirect for each renamed page and rejects invalid redirect targets", () => {
  const pages = new Map([["/introduction", "introduction.mdx"]]);
  assert.match(validateRedirects([], pages, [["README.mdx", "introduction.mdx"]])[0], /requires docs\.json redirect/);
  assert.deepEqual(validateRedirects([{ source: "/README", destination: "/introduction" }], pages, [["README.mdx", "introduction.mdx"]]), []);
  assert.ok(validateRedirects([{ source: "/old", destination: "/missing#anchor" }], pages).some((error) => /invalid destination/.test(error)));
  assert.ok(validateRedirects([{ source: "/old", destination: "/missing" }], pages).some((error) => /points to missing page \/missing/.test(error)));
  assert.ok(validateRedirects([{ source: "/old", destination: "/introduction" }, { source: "/old", destination: "/introduction" }], pages).some((error) => /Duplicate redirect source/.test(error)));
});

test("validates internal link anchors and reports stale fragments", () => {
  const pages = new Map([["/target", "target.mdx"]]);
  const anchors = new Map([["target.mdx", new Set(["valid-anchor"])]]);
  assert.deepEqual(validateLinkAnchor("source.mdx", "/target#valid-anchor", pages, anchors), []);
  assert.match(validateLinkAnchor("source.mdx", "/target#stale-anchor", pages, anchors)[0], /missing anchor/);
  assert.deepEqual(validateLinkAnchor("source.mdx", "/target#Getting%20Started", pages, new Map([["target.mdx", extractAnchors("## Getting Started")]])), []);
});

test("reports inbound links that still use a renamed page URL", () => {
  const links = extractLinks("[section](/README#section)");
  assert.match(validateRenamedPageLink("current.mdx", links[0], [["README.mdx", "introduction.mdx"]]), /still uses renamed page URL \/README; update it to \/introduction/);
});

test("scans unchanged inbound pages when documentation changes", () => {
  const pageFiles = ["target.mdx", "source.mdx"];
  const changedPages = new Set(["target.mdx"]);
  const scanFiles = getScanFiles(pageFiles, changedPages);

  assert.ok(scanFiles.has("target.mdx"));
  assert.ok(scanFiles.has("source.mdx"));
  assert.equal(scanFiles.size, 2);
});

test("excludes only the i18n guide's intentional starter-page link example", () => {
  assert.equal(isExcludedLink("docs/i18n.md", "/guides/my-guide"), true);
  assert.equal(isExcludedLink("docs/i18n.md", "/guides/my-guide.es"), false);
  assert.equal(isExcludedLink("guides/example.mdx", "/guides/my-guide"), false);
});
