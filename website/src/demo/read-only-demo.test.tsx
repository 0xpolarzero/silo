import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadOnlyDemo } from './read-only-demo';

describe('the embedded production UI', () => {
  it('navigates the real sidebar and back history without enabling sandbox actions', async () => {
    const user = userEvent.setup();
    render(<ReadOnlyDemo />);
    const sidebar = screen.getByRole('navigation', { name: 'Silo navigation' });
    expect(within(sidebar).getByRole('button', { name: 'Collapse Settings menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(sidebar).getByRole('button', { name: 'Computers' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Add/ })).toBeDisabled();
    await user.click(within(sidebar).getByRole('button', { name: /^Secrets/ }));
    expect(screen.getByText('PACKAGE_TOKEN')).toBeVisible();
    expect(screen.getByRole('button', { name: /Add secret/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.getByRole('button', { name: /Add/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Go forward' }));
    expect(screen.getByText('PACKAGE_TOKEN')).toBeVisible();
  });

  it('shows fixture files, logs, network and settings without network requests', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('The demo must not fetch live data'));
    const user = userEvent.setup();
    render(<ReadOnlyDemo />);
    const sidebar = screen.getByRole('navigation', { name: 'Silo navigation' });
    for (const name of ['Files', 'Logs', 'Network', 'Activity', 'GitHub', 'Backup', 'Settings', 'Computers', 'Notifications']) {
      await user.click(within(sidebar).getByRole('button', { name: new RegExp(`^${name}`) }));
      const page = screen.getByRole('group', { name: 'Read-only sample data' });
      expect(page).toBeVisible();
      for (const control of page.querySelectorAll('button, input, select, textarea')) expect(control).toBeDisabled();
    }
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
});


it('expands actual local and remote VM SSH controls while keeping actions disabled', async () => {
  const user = userEvent.setup();
  render(<ReadOnlyDemo />);
  expect(screen.queryByText('build-server')).not.toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Remote VM' })).toBeVisible();
  for (const name of ['dev', 'personal']) {
    const disclosure = screen.getByRole('button', { name: `SSH controls for ${name}` });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  }
});

it('offers the production command menu for safe navigation', async () => {
  const user = userEvent.setup();
  render(<ReadOnlyDemo />);
  await user.click(screen.getByRole('button', { name: 'Search or jump to' }));
  const search = screen.getByRole('combobox', { name: 'Search commands' });
  await user.type(search, 'Secrets');
  await user.keyboard('{Enter}');
  expect(screen.getByText('PACKAGE_TOKEN')).toBeVisible();
  expect(screen.queryByRole('dialog', { name: 'Commands' })).not.toBeInTheDocument();
});

it('shows sandbox menus and sample storage without allowing native operations', async () => {
  const user = userEvent.setup();
  render(<ReadOnlyDemo />);
  await user.click(screen.getByRole('button', { name: 'More actions for dev' }));
  expect(screen.getByRole('menuitem', { name: 'Open dev desktop' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('menuitem', { name: 'Restart dev' })).toHaveAttribute('aria-disabled', 'true');
  await user.click(screen.getByRole('menuitem', { name: 'Storage for dev' }));
  expect(await screen.findByText('18.00 GiB')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reclaim unused space' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Reclaim history, 1 attempts' }));
  expect(screen.getByLabelText('Reclaim history entries')).toBeVisible();
});
