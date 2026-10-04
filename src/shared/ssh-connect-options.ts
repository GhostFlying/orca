export type SshConnectOptions = {
  /** No user asked for this connect, so a cancelled sign-in stays cancelled. */
  automatic?: boolean
  /** Refuse any authentication path that would ask the user for input. */
  nonInteractive?: boolean
}
