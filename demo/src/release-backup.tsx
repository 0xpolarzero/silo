import { TooltipProvider } from '@/components/ui/tooltip';
import { ApplicationShell } from '@/features/application/components/application-shell';
import type { ApplicationSource } from '@/features/application/model/application-source';
import type { BackupArchive, BackupController } from '@/features/application/model/backup-source';
import { BackupPage } from '@/features/application/pages/backup-page';
import { SettingsProvider } from '@/features/preferences/settings-store';
import { showcaseSource } from './showcase-fixtures';

const noop = () => undefined;
const archive: BackupArchive = {
  name: 'Silo-Backup-1790474400.silo-backup',
  archivePath: '/Users/developer/Backups/Silo-Backup-1790474400.silo-backup',
  completedLabel: 'Just now',
  size: '1.2 GB',
  destination: '/Users/developer/Backups',
  sandboxes: ['web'],
};

// Backup operates on local VMs. The showcase's remote lab must never appear as
// a backup target, and this stopped sandbox does not imply a stop/restart cycle.
const source: ApplicationSource = {
  ...showcaseSource,
  remoteComputers: [],
  workspaces: showcaseSource.workspaces
    .filter(({ computer, machine }) => !computer && machine.name === 'web')
    .map(workspace => ({ ...workspace, state: 'stopped', stateDetail: 'Stopped' })),
  backup: { lastArchive: '', completedLabel: '', compressedSize: '', destination: archive.destination },
};

const actions: BackupController['actions'] = {
  chooseDestination: async () => null,
  chooseArchive: async () => null,
  inspectArchive: async selected => ({ archive: selected, valid: false, reason: 'Release video fixtures do not inspect archives.' }),
  startBackup: noop,
  startRestore: noop,
  cancelOperation: noop,
  retryStart: noop,
  dismissOperation: noop,
};

function backupAt(frame: number): BackupController {
  const complete = frame >= 95;
  return {
    actions,
    state: {
      snapshotId: 'release-backup-web',
      operationId: 'release-backup-web-operation',
      availability: 'available',
      destination: archive.destination,
      archives: complete ? [archive] : [],
      operation: {
        operation: 'backup',
        archive,
        runningNames: [],
        ...(complete ? {
          kind: 'result',
          outcome: 'success',
          title: 'Backup complete',
          message: 'Backup completed successfully.',
        } : {
          kind: 'running',
          progress: 0,
          indeterminate: true,
          // These are the current native controller's phase and detail. The
          // older application-backup fixture describes phases it does not emit.
          phases: [{ title: 'Capture and verify', detail: 'Silo is creating verified self-contained snapshots.', tone: 'running' }],
        }),
      },
    },
  };
}

export function ReleaseBackup({ frame }: { frame: number }) {
  // All displayed state comes from the render frame. Inert actions keep native
  // IO and the production success-dismiss timer from changing this movie.
  return <div className="r-product" style={{ width: 1060, height: 670 }}>
    <SettingsProvider initialSettings={source.preferences}>
      <TooltipProvider>
        <ApplicationShell
          activeTab="backup"
          workspaceSection="overview"
          settingsSection="general"
          systemIssueStatus={null}
          workspaceAttention={{ errors: 0, warnings: 0 }}
          onTabChange={noop}
          onWorkspaceSectionChange={noop}
          onSettingsSectionChange={noop}
          canGoBack={false}
          canGoForward={false}
          onGoBack={noop}
          onGoForward={noop}
          reduceMotion
        >
          <BackupPage source={source} backup={backupAt(frame)} />
        </ApplicationShell>
      </TooltipProvider>
    </SettingsProvider>
  </div>;
}
