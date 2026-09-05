import { homedir } from 'node:os'
import {
  buildPosixTraeHomeProbeScript,
  parsePosixTraeHomeProbeOutput,
  TRAE_HOME_PROBE_MAX_LENGTH,
  type TraeHomePaths
} from '../main/trae/trae-home-paths'
import { runProcess } from '../shared/child-process/run-process'
import { buildRelayCommandEnv } from './relay-command-env'

export async function resolveRelayTraeHomes(
  shell: string,
  shellMode: '-lc' | '-ilc'
): Promise<TraeHomePaths> {
  const home = homedir()
  if (process.platform === 'win32') {
    return parsePosixTraeHomeProbeOutput(home, '')
  }
  try {
    const result = await runProcess({
      program: shell,
      args: [shellMode, buildPosixTraeHomeProbeScript()],
      env: buildRelayCommandEnv(process.env, process.platform),
      timeoutMs: 5000,
      maxOutputBytes: TRAE_HOME_PROBE_MAX_LENGTH * 3
    })
    return parsePosixTraeHomeProbeOutput(home, result.code === 0 ? result.stdout : '')
  } catch {
    return parsePosixTraeHomeProbeOutput(home, '')
  }
}
