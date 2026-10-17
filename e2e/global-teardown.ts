import { rmSync } from "node:fs";

export default function globalTeardown(): void {
  const root = process.env.E2E_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
}
