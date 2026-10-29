// Run by VS Code ("vscode:uninstall") after the extension is removed:
// take the logging hook back out of Claude Code's settings.

const fs = require('fs');
const path = require('path');
const setup = require('./hook-setup');

try {
  setup.unregisterHooks();
  fs.rmSync(path.dirname(setup.installedHookPath()), { recursive: true, force: true });
} catch {}
