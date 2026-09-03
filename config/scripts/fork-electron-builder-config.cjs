const base = require('../electron-builder.config.cjs')

const win = { ...base.win, verifyUpdateCodeSignature: false }
delete win.signtoolOptions

module.exports = {
  ...base,
  win,
  publish: {
    ...base.publish,
    owner: 'GhostFlying',
    repo: 'orca',
    releaseType: 'prerelease'
  }
}
