const base = require('../electron-builder.config.cjs')

const win = { ...base.win, verifyUpdateCodeSignature: false }
delete win.signtoolOptions

const macArchitecture = process.env.ORCA_FORK_MAC_ARCH
if (macArchitecture && macArchitecture !== 'x64' && macArchitecture !== 'arm64') {
  throw new Error(`Unsupported ORCA_FORK_MAC_ARCH: ${macArchitecture}`)
}
const macTargets = macArchitecture
  ? base.mac.target.map((target) => ({ ...target, arch: [macArchitecture] }))
  : base.mac.target

module.exports = {
  ...base,
  win,
  mac: {
    ...base.mac,
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    target: macTargets
  },
  publish: {
    ...base.publish,
    owner: 'GhostFlying',
    repo: 'orca',
    releaseType: 'prerelease'
  }
}
