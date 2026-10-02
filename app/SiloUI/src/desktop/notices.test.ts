import { beforeEach, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({ tauri: true, invoke: vi.fn(), listen: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => native.tauri, invoke: native.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }))

import { clearSandboxNotices, deliverNotice, listenForNotices, noticeSchema, type Notice } from "./notices"

const notice: Notice = { category: "failures", key: "push:dev", title: "Push failed", body: "rejected", sandbox: { id: "vm-1", name: "dev" } }

beforeEach(() => {
  native.tauri = true
  native.invoke.mockReset().mockResolvedValue(undefined)
  native.listen.mockReset()
})

it("delivers a notice and clears a sandbox's notices with the wire shape", () => {
  deliverNotice(notice)
  clearSandboxNotices("vm-1")
  expect(native.invoke).toHaveBeenNthCalledWith(1, "deliver_notice", { notice })
  expect(native.invoke).toHaveBeenNthCalledWith(2, "clear_sandbox_notices", { sandboxId: "vm-1" })
})

it("is a no-op outside the desktop app and never throws when delivery fails", async () => {
  native.tauri = false
  deliverNotice(notice)
  listenForNotices(() => {})()
  expect(native.invoke).not.toHaveBeenCalled()
  expect(native.listen).not.toHaveBeenCalled()
  native.tauri = true
  native.invoke.mockRejectedValue(new Error("boom"))
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  expect(() => deliverNotice(notice)).not.toThrow()
  await Promise.resolve()
  await Promise.resolve()
  expect(log).toHaveBeenCalled()
  log.mockRestore()
})

it("forwards valid backend notices, ignores malformed ones, and stops listening on dispose", async () => {
  const stop = vi.fn()
  let emit!: (event: { payload: unknown }) => void
  native.listen.mockImplementation(async (_event: string, handler: typeof emit) => { emit = handler; return stop })
  const handler = vi.fn()
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  const dispose = listenForNotices(handler)
  await Promise.resolve()
  await Promise.resolve()
  expect(native.listen).toHaveBeenCalledWith("silo://notice", expect.any(Function))
  emit({ payload: notice })
  emit({ payload: { category: "other", key: "x" } })
  expect(handler).toHaveBeenCalledExactlyOnceWith(notice)
  dispose()
  expect(stop).toHaveBeenCalledOnce()
  log.mockRestore()
})

it("accepts a notice without a sandbox and rejects an unknown category", () => {
  expect(noticeSchema.safeParse({ ...notice, sandbox: null }).success).toBe(true)
  expect(noticeSchema.safeParse({ ...notice, category: "health" }).success).toBe(false)
})

it.fails("bug: disposed notice subscription forwards events before pending registration completes", async () => {
  let register!: (stop: () => void) => void
  let emit!: (event: { payload: unknown }) => void
  const stop = vi.fn()
  native.listen.mockImplementation((_event: string, handler: typeof emit) => {
    emit = handler
    return new Promise(resolve => { register = resolve })
  })
  const handler = vi.fn()
  const dispose = listenForNotices(handler)
  dispose()
  emit({ payload: notice })
  register(stop)
  await Promise.resolve()
  expect(stop).toHaveBeenCalledOnce()
  expect(handler).not.toHaveBeenCalled()
})
