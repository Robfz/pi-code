import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "test"],
    // For every git the tests run: no signing (a user's gpg fails intermittently under parallel
    // load), and no detached `git maintenance` after commits, which can write into a repo while
    // its test deletes it.
    env: {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "tag.gpgsign",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "maintenance.auto",
      GIT_CONFIG_VALUE_2: "false",
    },
  },
});
