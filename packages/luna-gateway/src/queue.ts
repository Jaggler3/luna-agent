import { createInterface } from 'node:readline'
import type { Socket } from 'node:net'
import type { GatewayMessage } from './types'
import { parseGatewayMessage } from './types'

export function createReceiveQueue(): {
  pushLine: (line: string) => void
  close: () => void
  receive: () => AsyncGenerator<GatewayMessage>
} {
  const buffer: GatewayMessage[] = []
  type Waiter = { resolve: (value: IteratorResult<GatewayMessage>) => void }
  const waiters: Waiter[] = []
  let closed = false

  function push(value: GatewayMessage) {
    const waiter = waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
    } else {
      buffer.push(value)
    }
  }

  const doneResult = (): IteratorResult<GatewayMessage> => ({ value: undefined as GatewayMessage | undefined, done: true } as IteratorResult<GatewayMessage>)

  function close() {
    closed = true
    while (waiters.length > 0) {
      waiters.shift()?.resolve(doneResult())
    }
  }

  function receive(): AsyncGenerator<GatewayMessage> {
    const localWaiters: Waiter[] = []
    let returned = false

    return {
      [Symbol.asyncIterator]() { return this },
      next(): Promise<IteratorResult<GatewayMessage>> {
        if (returned) return Promise.resolve(doneResult())
        if (buffer.length > 0) {
          return Promise.resolve({ value: buffer.shift()!, done: false })
        }
        if (closed) return Promise.resolve(doneResult())
        return new Promise((resolve) => {
          const waiter = { resolve }
          waiters.push(waiter)
          localWaiters.push(waiter)
        })
      },
      return(): Promise<IteratorResult<GatewayMessage>> {
        returned = true
        for (const waiter of localWaiters.splice(0)) {
          const idx = waiters.indexOf(waiter)
          if (idx !== -1) waiters.splice(idx, 1)
        }
        return Promise.resolve(doneResult())
      },
    }
  }

  return {
    pushLine: (line) => push(parseGatewayMessage(line)),
    close,
    receive,
  }
}

export function buildReceive(socket: Socket): () => AsyncGenerator<GatewayMessage> {
  const queue = createReceiveQueue()
  const rl = createInterface({ input: socket })
  rl.on('line', queue.pushLine)
  rl.on('close', queue.close)
  return queue.receive
}
