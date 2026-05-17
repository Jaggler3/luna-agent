import { simpleRun } from 'luna-code'
import { createServer } from 'luna-gateway'

const server = createServer({
  agentId: process.env.AGENT_ID ?? 'agent',
  handler: async (prompt, emit) => {
    await simpleRun(prompt, {
      onToolCall: (name, args) => emit({ type: 'tool_call', name, args }),
      onToken: (token) => emit({ type: 'token', content: token }),
      onReasoning: (chunk) => emit({ type: 'reasoning', content: chunk }),
    })
    emit({ type: 'done' })
  },
})

await server.listen()
