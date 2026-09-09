import { describe, expect, it, vi } from 'vitest'
import { createDirectoryStore, directoryKey, type DirectoryPage } from './directory-store'

const entry = (name: string) => ({ name, path: `/workspace/${name}`, kind: 'file' as const })
const page = (names: string[], nextOffset: number | null = null): DirectoryPage => ({ snapshotId: "snapshot", entries: names.map(entry), nextOffset })
function deferred() {
  let resolve!: (value: DirectoryPage) => void
  const promise = new Promise<DirectoryPage>(done => { resolve = done })
  return { promise, resolve }
}
const key = directoryKey('dev', '/workspace')

describe('directory store', () => {
  it('deduplicates in-flight requests and preserves stable snapshots until a change', async () => {
    const response = deferred()
    const loader = vi.fn(() => response.promise)
    const store = createDirectoryStore(loader)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(key, listener)
    const first = store.load('dev', '/workspace')
    expect(store.load('dev', '/workspace')).toBe(first)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot(key)).toBe(store.getSnapshot(key))
    expect(store.getSnapshot(key).loading).toBe(true)
    response.resolve(page(['a']))
    await first
    expect(store.getSnapshot(key).entries).toEqual([entry('a')])
    await store.load('dev', '/workspace')
    expect(loader).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('limits directory requests to three, including queued requests', async () => {
    const responses = Array.from({ length: 5 }, deferred)
    let next = 0
    const loader = vi.fn(() => responses[next++].promise)
    const store = createDirectoryStore(loader)
    const requests = responses.map((_, index) => store.load('dev', `/workspace/${index}`))
    expect(loader).toHaveBeenCalledTimes(3)
    responses[0].resolve(page([]))
    await requests[0]
    expect(loader).toHaveBeenCalledTimes(4)
    responses[1].resolve(page([]))
    await requests[1]
    expect(loader).toHaveBeenCalledTimes(5)
    responses.slice(2).forEach(response => response.resolve(page([])))
    await Promise.all(requests)
  })

  it('discards active results and cancels queued requests when a workspace is invalidated', async () => {
    const response = deferred()
    const loader = vi.fn(() => response.promise)
    const store = createDirectoryStore(loader)
    const requests = [0, 1, 2, 3].map(index => store.load('dev', `/workspace/${index}`))
    store.invalidateWorkspace('dev')
    await requests[3]
    response.resolve(page(['obsolete']))
    await Promise.all(requests)
    expect(loader).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot(directoryKey('dev', '/workspace/0')).entries).toBeNull()
    await store.load('dev', '/workspace')
    expect(store.getSnapshot(key).entries).toEqual([entry('obsolete')])
  })

  it('does not allow an older result to overwrite a new load after invalidation', async () => {
    const old = deferred()
    const fresh = deferred()
    const loader = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const store = createDirectoryStore(loader)
    const first = store.load('dev', '/workspace')
    store.invalidateWorkspace('dev')
    const second = store.load('dev', '/workspace')
    fresh.resolve(page(['new']))
    await second
    old.resolve(page(['old']))
    await first
    expect(store.getSnapshot(key).entries).toEqual([entry('new')])
  })

  it('keeps previous pages on failed pagination and allows retry', async () => {
    const loader = vi.fn().mockResolvedValueOnce(page(['a'], 1)).mockRejectedValueOnce(new Error('PRIVATE BACKEND DETAILS')).mockResolvedValueOnce(page(['b']))
    const store = createDirectoryStore(loader)
    await store.load('dev', '/workspace')
    await store.load('dev', '/workspace', { more: true })
    expect(store.getSnapshot(key)).toMatchObject({ entries: [entry('a')], nextOffset: 1, error: 'Could not load this folder. Retry.' })
    await store.load('dev', '/workspace', { more: true })
    expect(store.getSnapshot(key).entries).toEqual([entry('a'), entry('b')])
    expect(loader.mock.calls.map(call => call[2])).toEqual([0, 1, 1])
  })

  it('refreshes loaded pages atomically while retaining cached data on partial failure', async () => {
    const refresh = deferred()
    const loader = vi.fn().mockResolvedValueOnce(page(['a'], 1)).mockResolvedValueOnce(page(['b'], 2))
      .mockReturnValueOnce(refresh.promise).mockRejectedValueOnce(new Error('failure'))
      .mockResolvedValueOnce(page(['c'], 1)).mockResolvedValueOnce(page(['d'], 2))
    const store = createDirectoryStore(loader)
    await store.load('dev', '/workspace')
    await store.load('dev', '/workspace', { more: true })
    const refreshing = store.load('dev', '/workspace', { refresh: true })
    expect(store.getSnapshot(key)).toMatchObject({ entries: [entry('a'), entry('b')], loading: true })
    refresh.resolve(page(['c'], 1))
    await refreshing
    expect(store.getSnapshot(key)).toMatchObject({ entries: [entry('a'), entry('b')], nextOffset: 2, loading: false })
    await store.load('dev', '/workspace', { refresh: true })
    expect(store.getSnapshot(key)).toMatchObject({ entries: [entry('c'), entry('d')], nextOffset: 2, error: null })
    expect(loader.mock.calls.map(call => call[2])).toEqual([0, 1, 0, 1, 0, 1])
  })

  it('bounds inactive cached directories while retaining subscribed ones', async () => {
    const store = createDirectoryStore(async () => page(['a']))
    const unsubscribe = store.subscribe(key, () => {})
    await store.load('dev', '/workspace')
    for (let index = 0; index < 130; index++) await store.load('dev', `/workspace/${index}`)
    expect(store.getSnapshot(key).entries).toEqual([entry('a')])
    expect(store.getSnapshot(directoryKey('dev', '/workspace/0')).entries).toBeNull()
    expect(store.getSnapshot(directoryKey('dev', '/workspace/129')).entries).toEqual([entry('a')])
    unsubscribe()
  })

  it('disposes active and queued work without publishing late results', async () => {
    const response = deferred()
    const loader = vi.fn(() => response.promise)
    const store = createDirectoryStore(loader)
    const requests = [0, 1, 2, 3].map(index => store.load('dev', `/workspace/${index}`))
    store.dispose()
    await requests[3]
    response.resolve(page(['a']))
    await Promise.all(requests)
    await store.load('dev', '/workspace')
    expect(loader).toHaveBeenCalledTimes(3)
    expect(store.getSnapshot(key).entries).toBeNull()
  })
  it('carries the snapshot through pagination and starts a new one for refresh', async () => {
    const loader = vi.fn().mockResolvedValueOnce({ ...page(['a'], 1), snapshotId: 'first' })
      .mockResolvedValueOnce({ ...page(['b']), snapshotId: 'first' })
      .mockResolvedValueOnce({ ...page(['c'], 1), snapshotId: 'second' })
      .mockResolvedValueOnce({ ...page(['d']), snapshotId: 'second' })
    const store = createDirectoryStore(loader)
    await store.load('dev', '/workspace')
    await store.load('dev', '/workspace', { more: true })
    await store.load('dev', '/workspace', { refresh: true })
    expect(loader.mock.calls.map(call => [call[2], call[3]])).toEqual([[0, undefined], [1, 'first'], [0, undefined], [1, 'second']])
    expect(store.getSnapshot(key).snapshotId).toBe('second')
  })

  it('rejects mixed snapshots without replacing cached files and requests refresh on retry', async () => {
    const loader = vi.fn().mockResolvedValueOnce({ ...page(['a'], 1), snapshotId: 'first' })
      .mockResolvedValueOnce({ ...page(['b']), snapshotId: 'second' })
    const store = createDirectoryStore(loader)
    await store.load('dev', '/workspace')
    await store.load('dev', '/workspace', { more: true })
    expect(store.getSnapshot(key)).toMatchObject({ entries: [entry('a')], snapshotId: 'first', errorOperation: 'refresh', error: 'Folder changed. Reload to continue.' })
  })

  it('distinguishes loading more, preserves the retry operation, and surfaces only safe errors', async () => {
    const response = deferred()
    const loader = vi.fn().mockResolvedValueOnce(page(['a'], 1)).mockReturnValueOnce(response.promise)
      .mockRejectedValueOnce('Permission denied.')
    const store = createDirectoryStore(loader)
    await store.load('dev', '/workspace')
    const more = store.load('dev', '/workspace', { more: true })
    expect(store.getSnapshot(key).loadingMore).toBe(true)
    response.resolve(page(['b'], 2))
    await more
    expect(store.getSnapshot(key).loadingMore).toBe(false)
    await store.load('dev', '/workspace', { more: true })
    expect(store.getSnapshot(key)).toMatchObject({ error: 'Permission denied.', errorOperation: 'more', loadingMore: false })
  })

  it('requires refresh after native snapshot expiry', async () => {
    const loader = vi.fn().mockResolvedValueOnce(page(['a'], 1)).mockRejectedValueOnce('Folder listing expired. Refresh this folder.')
    const store = createDirectoryStore(loader)
    await store.load('dev', '/workspace')
    await store.load('dev', '/workspace', { more: true })
    expect(store.getSnapshot(key)).toMatchObject({ entries: [entry('a')], errorOperation: 'refresh', error: 'Folder listing expired. Refresh this folder.' })
  })

})
