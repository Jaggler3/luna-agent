import { simpleRun } from 'luna-code'
import { createServer } from 'luna-gateway'

const server = createServer({
  agentId: process.env.AGENT_ID ?? 'agent',
  handler: async (prompt, emit) => {
    return simpleRun(prompt, {
      onToolCall: (name, args) => {
        emit({ type: 'tool_call', name, args })
      },
    })
  },
})

await server.listen()
