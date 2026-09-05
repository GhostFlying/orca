import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import type { MobileNativeChatTab } from './native-chat/mobile-native-chat-eligibility'

export const CHAT_CAPABILITIES = {
  nativeChatTranscriptIsLocalReadable: true,
  traexChatSupported: true
} as const

export const structuredOptionSnapshot: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: {
      type: 'select',
      currentValue: 'gpt-fast',
      choices: [{ value: 'gpt-fast', label: 'GPT Fast' }]
    },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }
]

export const baseTab = {
  type: 'terminal',
  launchAgent: 'claude',
  agentStatus: {
    agentType: 'claude',
    state: 'waiting',
    prompt: '',
    updatedAt: 10,
    paneKey: 'tab-1:leaf-1',
    stateHistory: [],
    stateStartedAt: 10,
    providerSession: { id: 'session-1', key: 'session_id' },
    lastAssistantMessage: 'Pick destination?\n1. East\n2. West'
  }
} satisfies MobileNativeChatTab

export const permissionTab = {
  ...baseTab,
  agentStatus: {
    ...baseTab.agentStatus,
    lastAssistantMessage: '',
    interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'echo yes' } })
  }
} satisfies MobileNativeChatTab
