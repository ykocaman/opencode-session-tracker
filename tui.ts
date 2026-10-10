// Root TUI entry point for OpenCode v2.
//
// v2 loads a local-directory plugin's TUI from a literal `<dir>/tui` file
// (extension-probed), so this re-export is what makes the plugin load.
// The package.json `./tui` export map covers npm consumers.
export { default } from "./src/index";
