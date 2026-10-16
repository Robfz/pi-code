import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerServiceWorker } from "./features/pwa/register-sw.ts";
import { syncThemeColor } from "./lib/theme-color.ts";
import "./index.css";
import "./palettes.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

syncThemeColor();
registerServiceWorker();
