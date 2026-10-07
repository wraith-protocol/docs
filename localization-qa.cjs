/**
 * Localization QA for Wraith Protocol documentation
 *
 * Checks translated documentation pages (detected by a locale suffix such as
 * `guides/stellar-quickstart.es`) for:
 * - Missing locale metadata ("locale" front matter)
 * - Missing canonical metadata ("canonical" front matter or <link rel="canonical">)
 * - Stale links (compared by URL against the English source)
 * - Missing sections (heading outline comparison)
 * - Code drift
 *
 * Exits with code 1 when any issue is found.
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.join(__dirname);
const MARKDOWN_EXT = ['.md', '.mdx'];

const SKIP_DIRS = new Set(['.git', '.agents', 'node_modules']);
const SKIP_FILES = new Set(['docs.json', 'CLAUDE.md']);

function parseFrontMatter(content) {
  const raw = content.replace(/^\uFEFF/, '');
  let attrs = {};
  let body = raw;

  const fmMatch = raw.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m);
  if (fmMatch) {
    const attrsObj = {};
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (match) {
        let value = match[2].trim();
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (value !== '' && !isNaN(value)) value = Number(value);
        attrsObj[match[1]] = value;
      }
    }
    attrs = attrsObj;
    body = raw.substring(fmMatch[0].length).trim();
  }

  return { attrs, body };
}

function extractHeadings(body) {
  const headings = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i + 1,
      });
    }
  }
  return headings;
}

function countCodeFences(body) {
  const lines = body.split('\n');
  let count = 0;
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      count++;
    }
  }
  return count;
}

function extractLinks(body) {
  const links = [];
  const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    links.push({
      text: match[1],
      url: match[2],
      line: match.index,
    });
  }
  return links;
}

function classifyLink(url) {
  if (!url) return 'external';
  if (url.startsWith('/') || url.startsWith('#')) return 'internal';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'external';
  return 'internal';
}

function normalizePagePath(page) {
  if (!page) return '';
  let p = page.replace(/^\/|\/$/g, '');
  return p.toLowerCase();
}

function getNavPages(navigation) {
  const pages = [];

  if (!navigation || !navigation.tabs || !Array.isArray(navigation.tabs)) return pages;

  for (const tab of navigation.tabs) {
    const groups = tab.groups;
    if (!groups || !Array.isArray(groups)) continue;

    for (const group of groups) {
      const groupPages = group.pages;
      if (groupPages && Array.isArray(groupPages)) {
        for (const page of groupPages) {
          pages.push(normalizePagePath(page));
        }
      }
      if (group.items && Array.isArray(group.items)) {
        for (const subItem of group.items) {
          const subPages = subItem.pages;
          if (subPages && Array.isArray(subPages)) {
            for (const page of subPages) {
              pages.push(normalizePagePath(page));
            }
          }
          const subGroups = subItem.groups;
          if (subGroups && Array.isArray(subGroups)) {
            for (const subGroup of subGroups) {
              const sgPages = subGroup.pages;
              if (sgPages && Array.isArray(sgPages)) {
                for (const page of sgPages) {
                  pages.push(normalizePagePath(page));
                }
              }
            }
          }
        }
      }
    }
  }

  return pages;
}

function getAllMDXFiles() {
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (MARKDOWN_EXT.some(ext => entry.name.endsWith(ext))) {
        // Skip non-doc files
        if (SKIP_FILES.has(entry.name)) continue;
        files.push(fullPath);
      }
    }
  }

  walk(DOCS_DIR);
  return files;
}

function getPageKey(filePath) {
  const rel = path.relative(DOCS_DIR, filePath);
  const withoutExt = path.extname(rel) ? rel.replace(path.extname(rel), '') : rel;
  return withoutExt.replace(/\\/g, '/');
}

function hasLocaleMetadata(attrs) {
  return attrs.locale !== undefined && attrs.locale !== null;
}

// A page whose filename carries a locale suffix (e.g. guides/stellar-quickstart.es)
// is a translation. Detection is filename-based so a translated page that forgets
// its "locale" front matter is still counted and reported as a failure.
function parseTranslatedKey(pageKey) {
  const base = pageKey.slice(pageKey.lastIndexOf('/') + 1);
  const match = base.match(/^(.+)\.([a-z]{2})$/);
  if (!match) return null;
  return {
    locale: match[2],
    sourcePageKey: pageKey.slice(0, -(match[2].length + 1)),
  };
}

// Canonical metadata is either a "canonical" front matter field or a
// <link rel="canonical"> tag in the page body. Returns the URL, or null.
function getCanonicalMetadata(attrs, body) {
  if (attrs.canonical !== undefined && attrs.canonical !== null && attrs.canonical !== '') {
    return String(attrs.canonical).trim();
  }
  const tag = body.match(/<link\b[^>]*\brel=["'][^"']*canonical[^"']*["'][^>]*>/i);
  if (!tag) return null;
  const href = tag[0].match(/\bhref=["']([^"']+)["']/i);
  return href ? href[1] : null;
}

function runQA() {
  console.log('=== Wraith Protocol Localization QA ===\n');

  // 1. Read docs.json
  const docsJSONPath = path.join(DOCS_DIR, 'docs.json');
  let navigation;
  if (fs.existsSync(docsJSONPath)) {
    const jsonContent = fs.readFileSync(docsJSONPath, 'utf-8');
    const docsConfig = JSON.parse(jsonContent);
    navigation = docsConfig.navigation;
    console.log('Loaded navigation from docs.json\n');
  } else {
    console.warn('docs.json not found\n');
    navigation = null;
  }

  // Get canonical page paths from navigation
  const canonicalPages = navigation ? getNavPages(navigation) : [];
  console.log(`Canonical pages from navigation: ${canonicalPages.length}\n`);
  console.log('  ', canonicalPages.join(', '), '\n');

  // 2. Get all markdown files
  const allFiles = getAllMDXFiles();
  console.log(`Total markdown files found: ${allFiles.length}\n`);

  // 3. Parse all files
  const fileData = [];

  for (const filePath of allFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontMatter(content);
      const pageKey = getPageKey(filePath);
      const translation = parseTranslatedKey(pageKey);
      const declaredLocale = hasLocaleMetadata(parsed.attrs)
        ? String(parsed.attrs.locale)
        : null;

      const headings = extractHeadings(parsed.body);
      const codeFenceCount = countCodeFences(parsed.body);
      const links = extractLinks(parsed.body);
      const classifiedLinks = links.map(l => ({
        ...l,
        type: classifyLink(l.url),
      }));

      fileData.push({
        filePath,
        pageKey,
        title: parsed.attrs.title || 'Untitled',
        description: parsed.attrs.description || '',
        isTranslated: translation !== null,
        expectedLocale: translation ? translation.locale : null,
        sourcePageKey: translation ? translation.sourcePageKey : null,
        declaredLocale,
        canonical: getCanonicalMetadata(parsed.attrs, parsed.body),
        headings,
        codeFenceCount,
        links: classifiedLinks,
        rawBody: parsed.body,
      });
    } catch (err) {
      console.error(`Error parsing ${filePath}:`, err.message);
    }
  }

  // Build map of page keys
  const pageMap = new Map();
  for (const fd of fileData) {
    pageMap.set(fd.pageKey, fd);
  }

  // 4. Identify source vs translated pages
  const translatedPages = new Set();
  const sourceLanguagePages = new Set();

  for (const [key, fd] of pageMap) {
    if (fd.isTranslated) {
      translatedPages.add(key);
    } else {
      sourceLanguagePages.add(key);
    }
  }

  console.log(`Source language (English) pages: ${sourceLanguagePages.size}`);
  console.log(`Translated pages: ${translatedPages.size}\n`);

  // 5. Define supported translated pages (from navigation)
  const supportedTranslated = new Set();
  if (navigation) {
    for (const pageKey of canonicalPages) {
      if (!pageMap.has(pageKey)) {
        console.log(`  Warning: Page in navigation but not found in docs: ${pageKey}`);
      } else {
        supportedTranslated.add(pageKey);
      }
    }
  }

  console.log(`Supported pages for translation: ${supportedTranslated.size}\n`);

  // 6. Compare structure between source and translated pages
  const issues = [];

  for (const pageKey of translatedPages) {
    const fd = pageMap.get(pageKey);
    const sourcePageKey = fd.sourcePageKey;

    const sourceFd = pageMap.get(sourcePageKey);

    if (!sourceFd) {
      issues.push({
        type: 'missing_source',
        page: pageKey,
        message: `Could not find source English page for translated page: ${sourcePageKey}`,
      });
      continue;
    }

    if (sourceFd) {
      // Compare heading structure. Heading text is translated, so only the
      // outline (count and nesting levels) is compared — a section added to or
      // dropped from the translation changes the outline.
      const sourceLevels = sourceFd.headings.map(h => h.level);
      const translatedLevels = fd.headings.map(h => h.level);

      if (sourceLevels.join(',') !== translatedLevels.join(',')) {
        issues.push({
          type: 'heading_drift',
          page: pageKey,
          message: `Heading structure mismatch: source=${sourceLevels.join(',')} vs translation=${translatedLevels.join(',')}`,
          details: {
            sourceHeadings: sourceFd.headings.map(h => `${h.level}: ${h.text}`),
            translatedHeadings: fd.headings.map(h => `${h.level}: ${h.text}`),
          },
        });
      }

      // Compare code fence counts
      if (sourceFd.codeFenceCount !== fd.codeFenceCount) {
        issues.push({
          type: 'code_drift',
          page: pageKey,
          message: `Code fence count mismatch: source=${sourceFd.codeFenceCount}, translation=${fd.codeFenceCount}`,
          details: {
            sourceFenceCount: sourceFd.codeFenceCount,
            translatedFenceCount: fd.codeFenceCount,
          },
        });
      }

      // Compare link targets. Link text is translated, so URLs are compared.
      const sourceUrls = new Set(sourceFd.links.map(l => l.url));
      const translatedUrls = new Set(fd.links.map(l => l.url));

      // Links in translation not in source
      for (const translatedLink of fd.links) {
        if (sourceUrls.has(translatedLink.url)) continue;

        if (translatedLink.type === 'external') {
          issues.push({
            type: 'link_structural',
            page: pageKey,
            message: `Link in translation not in source: ${translatedLink.text} (${translatedLink.url})`,
            details: { type: translatedLink.type },
          });
        } else {
          issues.push({
            type: 'link_structural',
            page: pageKey,
            message: `Internal link in translation not in source: ${translatedLink.text} (${translatedLink.url})`,
            details: { type: translatedLink.type },
          });
        }
      }

      // Internal links in source missing from translation
      for (const sourceLink of sourceFd.links) {
        if (sourceLink.type !== 'internal') continue;
        if (translatedUrls.has(sourceLink.url)) continue;

        issues.push({
          type: 'link_missing',
          page: pageKey,
          message: `Internal link missing from translation: ${sourceLink.text} (${sourceLink.url})`,
        });
      }
    }
  }

  // 7. Check locale metadata on translated pages
  console.log('\n=== Locale Metadata Check ===');
  if (translatedPages.size === 0) {
    console.log('  (no translated pages found)');
  }
  for (const pageKey of translatedPages) {
    const fd = pageMap.get(pageKey);
    if (!fd.declaredLocale) {
      issues.push({
        type: 'missing_locale',
        page: pageKey,
        message: `Missing locale metadata: add "locale: ${fd.expectedLocale}" to the front matter`,
      });
      console.log(`  ✗ ${pageKey}: missing locale metadata`);
    } else if (fd.declaredLocale !== fd.expectedLocale) {
      issues.push({
        type: 'locale_mismatch',
        page: pageKey,
        message: `Locale metadata "${fd.declaredLocale}" does not match the file suffix ".${fd.expectedLocale}"`,
      });
      console.log(`  ✗ ${pageKey}: locale="${fd.declaredLocale}" does not match file suffix ".${fd.expectedLocale}"`);
    } else {
      console.log(`  ✓ ${pageKey}: locale="${fd.declaredLocale}"`);
    }
  }

  // 8. Check canonical metadata on translated pages
  console.log('\n=== Canonical Metadata Check ===');
  if (translatedPages.size === 0) {
    console.log('  (no translated pages found)');
  }
  for (const pageKey of translatedPages) {
    const fd = pageMap.get(pageKey);
    if (!fd.canonical) {
      issues.push({
        type: 'missing_canonical',
        page: pageKey,
        message: 'Missing canonical metadata: add "canonical: /<source page path>" to the front matter or a <link rel="canonical"> tag',
      });
      console.log(`  ✗ ${pageKey}: missing canonical metadata`);
    } else {
      console.log(`  ✓ ${pageKey}: canonical="${fd.canonical}"`);
    }
  }

  // 9. Report summary
  console.log('\n=== QA Summary ===');

  const byType = {};
  for (const issue of issues) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
  }

  for (const [type, count] of Object.entries(byType)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log(`\nTotal issues: ${issues.length}`);

  if (issues.length === 0) {
    console.log('✓ All checks passed! Documentation is structurally sound.');
  } else {
    console.log('\n=== Detailed Issues ===');
    for (const issue of issues) {
      console.log(`\n[${issue.type}] ${issue.page}: ${issue.message}`);
      if (issue.details) {
        console.log(`    Details: ${JSON.stringify(issue.details)}`);
      }
    }
  }

  return { issues, fileData, pageMap, translatedPages, sourceLanguagePages, supportedTranslated };
}

module.exports = {
  runQA,
  parseFrontMatter,
  extractHeadings,
  countCodeFences,
  extractLinks,
  classifyLink,
  hasLocaleMetadata,
  parseTranslatedKey,
  getCanonicalMetadata,
};

// Run if executed directly
if (require.main === module) {
  const result = runQA();
  if (result.issues.length > 0) {
    process.exit(1);
  }
}