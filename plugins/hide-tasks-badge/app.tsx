// bb-plugin-hide-tasks-badge — hides the number bb draws on the Tasks icon.
//
// The bundled Navigation plugin draws a panel's badge as a span with
// `data-nav-rail-badge` inside the item's `data-nav-rail-item` (rail) or
// `data-sidebar-navigation-item` (list) wrapper. That markup is not a
// versioned API: if bb changes it, the badge simply shows again.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

const CSS = `
[data-nav-rail-item*="tasks"] [data-nav-rail-badge],
[data-sidebar-navigation-item*="tasks"] [data-nav-rail-badge] {
  display: none !important;
}
`;

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "hide-badge",
    mount: () => {
      const style = document.createElement("style");
      style.dataset.bbPlugin = "hide-tasks-badge";
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => style.remove();
    },
  });
});
