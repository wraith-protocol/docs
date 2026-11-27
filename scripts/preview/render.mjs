/**
 * render.mjs
 *
 * Minimal, dependency-free MDX renderer for the offline docs preview.
 *
 * The preview is not a substitute for the Mintlify production renderer. It
 * renders the shipped .mdx content (headings, tables, code fences, callouts,
 * cards, accordions, steps and tabs) into static HTML so Playwright can
 * exercise real navigation, anchors and generated reference sections without
 * a network connection or a live docs deployment.
 */

const COMPONENT_CLASS = {
  Note: "callout callout-note",
  Warning: "callout callout-warning",
  Info: "callout callout-info",
  Tip: "callout callout-tip",
  Callout: "callout",
  Frame: "frame",
  Columns: "columns",
  CardGroup: "card-group",
  AccordionGroup: "accordion-group",
  Steps: "steps",
  CodeGroup: "code-group",
};

/** Components whose opening tag may close on the same line. */
const VOID_SELF_CLOSING = new Set(["Card"]);

/**
 * Slugs match the ids Mintlify renders: lowercase, Markdown formatting
 * removed, sentence punctuation turned into dashes, and symbols such as
 * `/`, `+`, `&` and `—` preserved. Keep this in sync with
 * `scripts/check-broken-links.mjs`, which enforces the same rule for links.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .replace(/[.,:;!?()[\]#]/g, "-")
    .replace(/\s/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mintlify numbers duplicate heading ids from 2. */
function uniqueId(base, ctx) {
  let id = base;
  let suffix = 2;
  while (ctx.usedIds.has(id)) id = `${base}-${suffix++}`;
  ctx.usedIds.add(id);
  return id;
}

export function splitFrontmatter(source) {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return { frontmatter: {}, body: source };

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    frontmatter[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { frontmatter, body: source.slice(match[0].length) };
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render inline markdown (code spans, bold, italics, links, images, <br />)
 * inside already-blocked text. Code spans are extracted first so their
 * contents are escaped exactly once.
 */
export function renderInline(text) {
  const codeSpans = [];
  let working = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });

  // Preserve intentional inline HTML used in tables (`<br />`).
  working = working.replace(/<br\s*\/?>/gi, "\u0000BR\u0000");
  working = escapeHtml(working);
  working = working.replace(/\u0000BR\u0000/g, "<br />");

  working = working.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
    return `<img src="${src}" alt="${alt}" />`;
  });
  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
    const attrs = external ? ' rel="noreferrer noopener"' : "";
    return `<a href="${href}"${attrs}>${label}</a>`;
  });
  working = working.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  working = working.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  working = working.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
  return working;
}

function parseAttributes(raw) {
  const attrs = {};
  const source = raw.replace(/^<[A-Za-z0-9]+/, "").replace(/\/?>\s*$/, "");
  const re = /([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;
  let match;
  while ((match = re.exec(source))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function isBlockStart(line) {
  return (
    /^(```|~~~)/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^<[A-Z]/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line) ||
    /^\|/.test(line) ||
    /^-{3,}\s*$/.test(line) ||
    /^\s*\{\/\*/.test(line)
  );
}

function renderList(lines, start) {
  const itemRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
  const first = lines[start].match(itemRe);
  const baseIndent = first[1].length;
  const ordered = /\d+\./.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(itemRe);
    if (!match || match[1].length !== baseIndent) break;

    const itemLines = [match[3]];
    i += 1;
    // Continuation lines: indented, non-blank, and not a new item at this level.
    while (i < lines.length) {
      const next = lines[i];
      if (/^\s*$/.test(next)) break;
      const nextItem = next.match(itemRe);
      if (nextItem && nextItem[1].length === baseIndent) break;
      if (!nextItem && !/^\s{2,}/.test(next)) break;
      itemLines.push(next.trim());
      i += 1;
    }
    items.push(renderInline(itemLines.join(" ")));
  }

  const tag = ordered ? "ol" : "ul";
  return {
    html: `<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`,
    next: i,
  };
}

function renderTable(lines, start) {
  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const header = splitRow(lines[start]);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && /^\s*\|/.test(lines[i])) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }

  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("");

  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: i,
  };
}

/**
 * Find the matching closing tag for a component, respecting nesting of the
 * same component name. Returns the end line index (of the closing tag).
 */
function findClosingTag(lines, start, name) {
  let depth = 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (new RegExp(`^\\s*<${name}(\\s|>|/)`).test(line)) depth += 1;
    if (new RegExp(`^\\s*</${name}>`).test(line)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function renderTabs(innerLines) {
  const tabs = [];
  let i = 0;
  while (i < innerLines.length) {
    const line = innerLines[i];
    const open = line.match(/^\s*<Tab\b([^>]*)>/);
    if (!open) {
      i += 1;
      continue;
    }
    const end = findClosingTag(innerLines, i, "Tab");
    if (end === -1) break;
    const attrs = parseAttributes(line);
    const body = innerLines.slice(i + 1, end);
    tabs.push({
      title: attrs.title || `Tab ${tabs.length + 1}`,
      html: renderLines(body).html,
    });
    i = end + 1;
  }

  if (tabs.length === 0) {
    return `<div class="tabs-error" data-tabs-error="no-tab-children"></div>`;
  }

  const buttons = tabs
    .map(
      (tab, index) =>
        `<button type="button" role="tab" id="tab-${index}" aria-controls="tabpanel-${index}" aria-selected="${index === 0}" data-tab-button>${renderInline(tab.title)}</button>`,
    )
    .join("");
  const panels = tabs
    .map(
      (tab, index) =>
        `<div role="tabpanel" id="tabpanel-${index}" aria-labelledby="tab-${index}" data-tab-panel ${index === 0 ? "" : "hidden"}>${tab.html}</div>`,
    )
    .join("");

  return `<div class="tabs" data-tabs><div class="tablist" role="tablist">${buttons}</div><div class="tabpanels">${panels}</div></div>`;
}

/**
 * Render an MDX document body to HTML.
 *
 * @param {string} source
 * @returns {{ html: string, anchors: string[], generated: string[] }}
 */
export function renderMdx(source) {
  const { frontmatter, body } = splitFrontmatter(source);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const anchors = [];
  const generated = [];
  const result = renderLines(lines, { anchors, generated, usedIds: new Set() });

  const lead = frontmatter.description
    ? `<p class="page-description">${renderInline(frontmatter.description)}</p>`
    : "";

  return {
    frontmatter,
    html: lead + result.html,
    anchors,
    generated,
  };
}

function renderLines(lines, ctx = { anchors: [], generated: [], usedIds: new Set() }) {
  const out = [];
  let i = 0;
  let inImport = false;

  while (i < lines.length) {
    const line = lines[i];

    // Module-level import/export statements are not renderable content.
    if (/^(import|export)\b/.test(line)) {
      inImport = !/[;]\s*$/.test(line) && !/from\s+["'][^"']+["'];?\s*$/.test(line);
      i += 1;
      continue;
    }
    if (inImport) {
      if (/;?\s*$/.test(line) && (/from\s+["'][^"']+["'];?\s*$/.test(line) || /;\s*$/.test(line))) {
        inImport = false;
      }
      i += 1;
      continue;
    }

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // MDX comments double as generated-section markers.
    const marker = line.match(/^\s*\{\/\*\s*([a-z0-9-]+):(start|end)\s*\*\/\}\s*$/);
    if (marker) {
      if (marker[2] === "start") {
        ctx.generated?.push(marker[1]);
        out.push(`<section class="generated-reference" data-generated="${marker[1]}">`);
      } else {
        out.push("</section>");
      }
      i += 1;
      continue;
    }
    if (/^\s*\{\/\*[\s\S]*\*\/\}\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // Fenced code blocks.
    const fence = line.match(/^(```|~~~)\s*([A-Za-z0-9+#-]*)(.*)$/);
    if (fence) {
      const lang = fence[2] || "text";
      const code = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^${fence[1]}`).test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      out.push(
        `<pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Horizontal rule.
    if (/^-{3,}\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      let text = heading[2].trim();
      // Mintlify supports explicit heading IDs: `## Title {#custom-id}`.
      const explicitId = text.match(/\s*\{#([A-Za-z0-9_-]+)\}\s*$/);
      if (explicitId) text = text.slice(0, explicitId.index).trim();
      const id = uniqueId(explicitId ? explicitId[1] : slugify(text), ctx);
      if (!ctx.anchors.includes(id)) ctx.anchors.push(id);
      out.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // Tables.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    // Lists.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Components and inline HTML blocks.
    const component = line.match(/^\s*<([A-Z][A-Za-z0-9]*)\b([^>]*)>(\s*)$/);
    if (component) {
      const name = component[1];
      const attrs = parseAttributes(line);
      const selfClosing = /\/>\s*$/.test(line);

      if (selfClosing || VOID_SELF_CLOSING.has(name) && !findClosingTag(lines, i, name)) {
        if (name === "Card") {
          out.push(renderCard(attrs));
        } else if (name === "img") {
          out.push(renderImageTag(attrs));
        }
        i += 1;
        continue;
      }

      const end = findClosingTag(lines, i, name);
      if (end === -1) {
        i += 1;
        continue;
      }
      const innerLines = lines.slice(i + 1, end);

      if (name === "Tabs") {
        out.push(renderTabs(innerLines));
      } else if (name === "Card") {
        const inner = renderLines(innerLines, ctx).html;
        out.push(renderCard(attrs, inner));
      } else if (name === "Tab") {
        // A stray <Tab> outside <Tabs>; render plainly.
        out.push(`<section class="tab-fallback">${renderLines(innerLines, ctx).html}</section>`);
      } else if (name === "Accordion") {
        out.push(
          `<details class="accordion"><summary>${renderInline(attrs.title || "Details")}</summary><div class="accordion-body">${renderLines(innerLines, ctx).html}</div></details>`,
        );
      } else if (name === "Step") {
        out.push(
          `<div class="step"><h4>${renderInline(attrs.title || "")}</h4>${renderLines(innerLines, ctx).html}</div>`,
        );
      } else if (name === "CardGroup") {
        out.push(`<div class="card-group">${renderLines(innerLines, ctx).html}</div>`);
      } else {
        const cls = COMPONENT_CLASS[name] || "component";
        out.push(`<div class="${cls}">${renderLines(innerLines, ctx).html}</div>`);
      }
      i = end + 1;
      continue;
    }

    // Inline HTML (images, single-line tags).
    const imageTag = line.match(/^\s*<img\b[^>]*\/?>\s*$/i);
    if (imageTag) {
      out.push(renderImageTag(parseAttributes(line)));
      i += 1;
      continue;
    }

    // Paragraph: consume until a blank line or the next block construct.
    const paragraph = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !isBlockStart(lines[i]) &&
      !/^<[A-Za-z]/.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return { html: out.join("\n") };
}

function renderCard(attrs, innerHtml) {
  const title = attrs.title ? `<strong class="card-title">${renderInline(attrs.title)}</strong>` : "";
  const body = innerHtml ? `<span class="card-body">${innerHtml}</span>` : "";
  if (attrs.href) {
    return `<a class="card" href="${attrs.href}">${title}${body}</a>`;
  }
  return `<div class="card">${title}${body}</div>`;
}

function renderImageTag(attrs) {
  if (!attrs.src || attrs.src.includes("{")) return "";
  return `<img src="${attrs.src}" alt="${attrs.alt || ""}" />`;
}
