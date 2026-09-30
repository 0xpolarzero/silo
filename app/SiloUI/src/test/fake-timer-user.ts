import { getConfig } from "@testing-library/dom"
import { act, configure } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { onTestFinished, vi } from "vitest"

/**
 * RTL's default asyncWrapper drains a setTimeout(0) using Jest's timer API only:
 * https://github.com/testing-library/react-testing-library/blob/main/src/pure.js
 * Keep user-event's public advanceTimers option and drain React updates through
 * act instead while Vitest owns the clock. Restore the wrapper after this test.
 */
export function setupFakeTimerUser() {
  if (!vi.isFakeTimers()) throw new Error("Enable fake timers before setting up the user")
  const { asyncWrapper } = getConfig()
  configure({
    asyncWrapper: async callback => {
      let result: unknown
      await act(async () => { result = await callback() })
      return result
    },
  })
  onTestFinished(() => { configure({ asyncWrapper }) })
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync })
}
