const base = require('../electron-builder.config.cjs')

const win = { ...base.win, verifyUpdateCodeSignature: false }
delete win.signtoolOptions

module.exports = {
  ...base,
  win,
  mac: {
    ...base.mac,
    identity: '-',
    hardenedRuntime: false,
    notarize: false
  },
  publish: {
    ...base.publish,
    owner: 'GhostFlying',
    repo: 'orca',
    releaseType: 'prerelease'
  }
}
