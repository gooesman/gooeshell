function allowsUnsupportedGpuSkip(host, probe) {
  // This is an explicit coverage limitation of one hosted environment, not a
  // blanket macOS/Intel skip. A working native context followed by an xterm
  // failure, readback error or lost context must still fail the GPU regression.
  return host.platform === 'darwin' && host.arch === 'x64'
    && host.githubActions === 'true' && host.runnerEnvironment === 'github-hosted'
    && probe?.status === 'unavailable' && probe.contextCreated === false;
}
module.exports = { allowsUnsupportedGpuSkip };
