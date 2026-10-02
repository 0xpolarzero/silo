import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { OnboardingApp } from './onboarding-app'
import { createMemorySettingsStore, SettingsProvider } from '@/features/preferences/settings-store'
import { onboardingScenarios } from '@/fixtures/scenarios'

it('keeps an explicit OAuth choice through repository-mode edits and recovery', async () => {
  const source = { ...onboardingScenarios.complete, githubPolicies: [], machinesAuthoritative: true }
  const machine = source.machineConfigurations[0]
  const policies = [{ workspace: machine.name, authenticationMethod: 'token' as const,
    repositoryMode: 'selected' as const, allRepositoriesAllowChanges: false, repositories: [],
    identity: { name: 'Author', email: 'author@example.test', apply: false } }]
  const actions = { connectGitHub: vi.fn(), saveMachineConfiguration: vi.fn(), retryWorkspaceSetup: vi.fn(), finishSetup: vi.fn(), submitStep: vi.fn() }
  const firstStore = createMemorySettingsStore()
  const wrap = (store: ReturnType<typeof createMemorySettingsStore>) => <SettingsProvider store={store}>
    <OnboardingApp source={source} actions={actions} repositoryPolicies={policies} tokenConnected githubConnectionState='connected' completed={false} />
  </SettingsProvider>
  const user = userEvent.setup()
  const first = render(wrap(firstStore))
  await user.click(screen.getByRole('tab', { name: /GitHub/ }))
  await user.click(screen.getByRole('radio', { name: `Use GitHub OAuth for ${machine.name}` }))
  await user.click(screen.getByRole('checkbox', { name: `All repositories for ${machine.name}` }))
  expect(screen.getByRole('radio', { name: `Use GitHub OAuth for ${machine.name}` })).toBeChecked()
  await act(async () => { await firstStore.flush() })
  const recovered = structuredClone(firstStore.getSnapshot().onboardingDraft)
  expect(recovered?.workspaceRepositoryAccess?.[machine.name]?.authenticationMethod).toBe('oauth')
  first.unmount()
  const secondStore = createMemorySettingsStore({}, recovered)
  render(wrap(secondStore))
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(actions.submitStep).toHaveBeenLastCalledWith('github', expect.objectContaining({ github: expect.objectContaining({
    workspaces: expect.arrayContaining([expect.objectContaining({ workspace: machine.name, authenticationMethod: 'oauth' })])
  }) }))
})
