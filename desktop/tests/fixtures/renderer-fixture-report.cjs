const fs = require('node:fs/promises');

async function finishRendererFixture(app, reportFile, result, requestedExitCode = result.success ? 0 : 1) {
  // Keep the BrowserWindow alive here. Destroying the last window can quit
  // Electron before asynchronous writes finish, particularly on macOS. Readers
  // should see either a complete JSON report or no report, never a partial one.
  let exitCode = requestedExitCode;
  try {
    await fs.writeFile(reportFile + '.tmp', JSON.stringify(result, null, 2));
    await fs.rename(reportFile + '.tmp', reportFile);
  } catch (error) {
    exitCode = 1;
    console.error(`Failed to write renderer fixture report ${reportFile}:`, error);
  } finally {
    app.exit(exitCode);
  }
}

module.exports = { finishRendererFixture };
