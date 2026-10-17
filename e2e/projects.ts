import { devices, type Project } from "@playwright/test";

/**
 * Both configs' projects. Desktop is wide enough for the docked sidebar and the review pane
 * (`min-width: 64rem`); mobile is a touch phone, below that breakpoint.
 */
export const PROJECTS: Project[] = [
  {
    name: "desktop",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  },
  {
    name: "mobile",
    use: { ...devices["Pixel 7"] },
  },
];
