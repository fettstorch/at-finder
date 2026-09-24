import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import packageJson from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [
    cloudflare(),
    {
      name: "app-version",
      transformIndexHtml: (html) => html.replace("%APP_VERSION%", packageJson.version),
    },
  ],
});
