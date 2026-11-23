/*
 * preview.js — client runtime for the offline docs preview.
 *
 * Responsibilities:
 *   - mark the document as hydrated (tests fail when this never happens),
 *   - client-side navigation between preview pages,
 *   - anchor scrolling,
 *   - tab state for <Tabs> widgets,
 *   - the mobile navigation drawer.
 *
 * Deliberately dependency-free so the preview runs fully offline.
 */
(function () {
  "use strict";

  var state = (window.__preview = window.__preview || {
    hydrated: false,
    navigations: 0,
    errors: [],
  });

  function currentMain() {
    return document.querySelector("#preview-main");
  }

  function closeMenu() {
    document.body.removeAttribute("data-menu-open");
    var button = document.getElementById("preview-menu-button");
    if (button) button.setAttribute("aria-expanded", "false");
  }

  function scrollToHash(hash, behavior) {
    if (!hash) return false;
    var id = decodeURIComponent(hash.replace(/^#/, ""));
    var target = document.getElementById(id);
    if (!target) return false;
    target.scrollIntoView({ behavior: behavior || "auto", block: "start" });
    return true;
  }

  function wireTabs(root) {
    var widgets = root.querySelectorAll("[data-tabs]");
    for (var w = 0; w < widgets.length; w += 1) {
      (function (widget) {
        var tabs = Array.prototype.slice.call(widget.querySelectorAll("[data-tab-button]"));
        var panels = Array.prototype.slice.call(widget.querySelectorAll("[data-tab-panel]"));
        if (tabs.length === 0) return;

        function select(index, focus) {
          tabs.forEach(function (tab, i) {
            var active = i === index;
            tab.setAttribute("aria-selected", active ? "true" : "false");
            tab.setAttribute("tabindex", active ? "0" : "-1");
          });
          panels.forEach(function (panel, i) {
            if (i === index) panel.removeAttribute("hidden");
            else panel.setAttribute("hidden", "");
          });
          if (focus) tabs[index].focus();
        }

        tabs.forEach(function (tab, index) {
          tab.addEventListener("click", function () {
            select(index, false);
          });
          tab.addEventListener("keydown", function (event) {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            var next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : (index - 1 + tabs.length) % tabs.length;
            select(next, true);
          });
        });

        select(0, false);
      })(widgets[w]);
    }
  }

  function syncTabState(doc) {
    var activeTab = doc.documentElement.getAttribute("data-route");
    var newDocTab = doc.querySelector("#preview-main");
    var tab = newDocTab ? newDocTab.getAttribute("data-tab") : null;
    var links = document.querySelectorAll(".topbar-tabs [role='tab']");
    links.forEach(function (link) {
      var selected = link.getAttribute("data-tab-link") === tab;
      link.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    if (tab) document.documentElement.setAttribute("data-route", activeTab || "");
    return tab;
  }

  async function navigate(url, options) {
    var target = new URL(url, window.location.href);
    var response;
    try {
      response = await fetch(target.pathname + target.search, {
        headers: { Accept: "text/html" },
      });
    } catch (error) {
      state.errors.push(String(error));
      return false;
    }
    if (!response.ok) return false;

    var html = await response.text();
    var doc = new DOMParser().parseFromString(html, "text/html");
    var nextMain = doc.querySelector("#preview-main");
    var nextSidebar = doc.querySelector("#preview-sidebar");
    var currentMainNode = currentMain();
    if (!nextMain || !nextSidebar || !currentMainNode) return false;

    var sidebarHost = document.querySelector("#preview-sidebar");
    if (!sidebarHost) return false;

    currentMainNode.innerHTML = nextMain.innerHTML;
    currentMainNode.setAttribute("data-route", nextMain.getAttribute("data-route") || "");
    currentMainNode.setAttribute("data-tab", nextMain.getAttribute("data-tab") || "");
    currentMainNode.setAttribute("data-group", nextMain.getAttribute("data-group") || "");
    sidebarHost.innerHTML = nextSidebar.innerHTML;
    if (nextSidebar.getAttribute("data-tab")) {
      sidebarHost.setAttribute("data-tab", nextSidebar.getAttribute("data-tab"));
    }
    document.title = doc.title;
    document.documentElement.setAttribute("data-route", nextMain.getAttribute("data-route") || "");
    syncTabState(doc);
    wireTabs(currentMainNode);
    closeMenu();

    if (options && options.replace) {
      history.replaceState({ preview: true }, "", target.pathname + target.search + target.hash);
    } else {
      history.pushState({ preview: true }, "", target.pathname + target.search + target.hash);
      state.navigations += 1;
    }

    if (!scrollToHash(target.hash)) window.scrollTo(0, 0);
    document.dispatchEvent(new CustomEvent("preview:navigated", { detail: { url: target.href } }));
    return true;
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    var link = event.target.closest ? event.target.closest("a") : null;
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;

    var href = link.getAttribute("href");
    if (!href || href.startsWith("//")) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    if (!href.startsWith("/")) return;

    var target = new URL(href, window.location.href);
    var samePage =
      target.pathname === window.location.pathname && target.search === window.location.search;

    if (samePage && target.hash) {
      event.preventDefault();
      if (scrollToHash(target.hash, "smooth")) {
        history.pushState({ preview: true }, "", target.pathname + target.search + target.hash);
      }
      return;
    }

    event.preventDefault();
    navigate(target.href, { replace: false }).then(function (ok) {
      if (!ok) window.location.href = target.href;
    });
  });

  window.addEventListener("popstate", function () {
    navigate(window.location.href, { replace: true });
  });

  var menuButton = document.getElementById("preview-menu-button");
  if (menuButton) {
    menuButton.addEventListener("click", function () {
      var open = document.body.getAttribute("data-menu-open") === "true";
      document.body.setAttribute("data-menu-open", open ? "false" : "true");
      menuButton.setAttribute("aria-expanded", open ? "false" : "true");
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenu();
  });

  wireTabs(document);
  if (window.location.hash) {
    scrollToHash(window.location.hash);
    document.documentElement.setAttribute("data-anchor-ready", "true");
  }

  state.hydrated = true;
  document.documentElement.setAttribute("data-hydrated", "true");
})();
