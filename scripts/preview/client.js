// Client for the deterministic docs preview used by the render smoke tests.
// It mirrors the production router: same-origin links swap page content
// without a full reload, tabs follow the active section, and anchor links
// scroll to the matching heading.
(() => {
  const html = document.documentElement;
  html.dataset.hydrated = "true";
  html.dataset.navigations = "0";

  function applyTab(tabName) {
    document.body.dataset.tab = tabName;
    for (const link of document.querySelectorAll(".tab-link")) {
      link.classList.toggle("active", link.dataset.tab === tabName);
    }
    for (const section of document.querySelectorAll(".nav-tab")) {
      section.hidden = section.dataset.navTab !== tabName;
    }
  }

  function applyActivePage(pagePath) {
    for (const link of document.querySelectorAll(".nav-link")) {
      link.classList.toggle("active", link.dataset.page === pagePath);
    }
  }

  function scrollToHash(hash) {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ block: "start" });
    else console.error(`Preview: missing anchor #${id}`);
  }

  async function render(url, { push }) {
    const response = await fetch(url, {
      headers: { "X-Preview-Navigation": "1" },
      credentials: "same-origin",
    });
    const source = await response.text();
    const next = new DOMParser().parseFromString(source, "text/html");
    const nextContent = next.querySelector("#page-content");
    const currentContent = document.querySelector("#page-content");
    if (!nextContent || !currentContent) {
      console.error(`Preview: navigation target ${url} has no page content`);
      return;
    }

    document.title = next.title;
    currentContent.replaceWith(nextContent);
    document.body.dataset.page = next.body.dataset.page ?? "";
    applyTab(next.body.dataset.tab ?? "");
    applyActivePage(nextContent.dataset.page ?? "");

    const nextToc = next.querySelector(".toc");
    const currentToc = document.querySelector(".toc");
    if (nextToc && currentToc) currentToc.replaceWith(nextToc);

    if (push) history.pushState({ preview: true }, "", url);
    html.dataset.navigations = String(Number(html.dataset.navigations) + 1);
    for (const link of nextContent.querySelectorAll('a[href^="/"]')) link.dataset.internal = "true";
    scrollToHash(new URL(url, window.location.origin).hash);
    document.dispatchEvent(new CustomEvent("preview:navigated", { detail: { url } }));
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const href = link.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    // Same-page anchors use the browser's native scrolling.
    if (href.startsWith("#")) return;
    event.preventDefault();
    const target = new URL(href, window.location.origin);
    if (target.pathname === window.location.pathname && target.hash) {
      history.replaceState(null, "", target.hash);
      scrollToHash(target.hash);
      return;
    }
    render(target.href, { push: true }).catch((error) => {
      console.error(`Preview: failed to navigate to ${href}: ${error.message}`);
    });
  });

  window.addEventListener("popstate", () => {
    render(window.location.href, { push: false }).catch((error) => {
      console.error(`Preview: failed to restore ${window.location.href}: ${error.message}`);
    });
  });

  applyTab(document.body.dataset.tab ?? "");
  applyActivePage(document.querySelector("#page-content")?.dataset.page ?? "");
  if (window.location.hash) scrollToHash(window.location.hash);
})();
