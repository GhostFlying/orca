import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const {
  verifyPackagedOrcadTemplate
} = require('../../config/scripts/verify-packaged-orcad-template.cjs')

export function verifyForkOrcadTemplate(resourcesDir) {
  verifyPackagedOrcadTemplate(resourcesDir)
}

export function packagedResourcesDir(distDirectory, platform) {
  const directories = {
    'windows-x64': ['win-unpacked', 'resources'],
    'linux-x64': ['linux-unpacked', 'resources'],
    'linux-arm64': ['linux-arm64-unpacked', 'resources'],
    'macos-x64': ['mac', 'Orca.app', 'Contents', 'Resources'],
    'macos-arm64': ['mac-arm64', 'Orca.app', 'Contents', 'Resources']
  }
  const segments = directories[platform]
  if (!segments) {
    throw new Error(`Unsupported fork desktop platform: ${platform}`)
  }
  return join(distDirectory, ...segments)
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  verifyForkOrcadTemplate(packagedResourcesDir(resolve(process.argv[2]), process.argv[3]))
}
