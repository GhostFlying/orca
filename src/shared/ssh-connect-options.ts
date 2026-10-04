export type SshConnectOptions = {
  /** No user asked for this connect, so a cancelled sign-in stays cancelled. */
  automatic?: boolean
  /** Retry a bridged host's move; refusal keeps the host as it was. Implies automatic. */
  quiet?: boolean
  /** Refuse any authentication path that would ask the user for input. */
  nonInteractive?: boolean
}
