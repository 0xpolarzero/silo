import { useLayoutEffect, useRef, type ReactNode } from "react";
import { delayRender, continueRender } from "remotion";
import { ApplicationShell } from "@/features/application/components/application-shell";
import { OverviewPage } from "@/features/application/pages/overview-page";
import {
  ConnectComputerForm,
  RemoteComputersSettings,
} from "@/features/application/components/remote-computers-settings";
import { NetworkPage } from "@/features/application/pages/network-page";
import { SettingsProvider } from "@/features/preferences/settings-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { actions, demo, noop, office, sourceFor } from "./fixtures";
import { sshTiming } from "./ssh-timeline";
import { pastedAddress } from "./timeline";
import { WorkspacesPage } from "@/features/application/pages/workspaces-page";
import { createDirectoryStore } from "@/features/application/model/directory-store";
const directoryStore = createDirectoryStore(async () => ({
  snapshotId: "demo-files",
  entries: [
    {
      name: "hello-silo",
      path: "/workspace/hello-silo",
      kind: "folder" as const,
    },
  ],
  nextOffset: null,
}));

type Page = "ssh" | "overview" | "computers" | "connect" | "network" | "files";
export function Product({ page, frame }: { page: Page; frame: number }) {
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const selector =
      page === "files" && frame >= 80
        ? '[data-repository-header] [aria-label="Open in Zed"]'
        : page === "network" && frame >= 65 && frame < 110
          ? '[aria-label="Connect port 5173 to this computer"]'
          : page === "network" && frame >= 165 && frame < 220
            ? '[aria-label="Open http://127.0.0.1:53124 in Safari"]'
            : null;
    if (!selector) {
      if (page === "network") (document.activeElement as HTMLElement)?.blur();
      return;
    }
    const handle = delayRender("Show production action tooltip");
    surface.current
      ?.querySelector<HTMLButtonElement>(selector)
      ?.focus({ preventScroll: true });
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => continueRender(handle));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      continueRender(handle);
    };
  }, [page, frame]);
  const connected = page !== "connect" || frame >= 200;
  const created = page === "connect" || page === "network" || page === "files";
  const source = sourceFor({
    connected,
    created,
    enabled: page === "computers" && frame >= 90,
    starting: page === "connect",
    portConnected: page !== "network" || frame >= 110,
  });
  if (page === "ssh") {
    source.workspaces = [demo];
    source.sshAccess = {
      workspaces: [
        {
          workspace: demo.machine.id,
          computerName: "Office Mac",
          enabled: frame >= sshTiming.local,
          port: 2222,
          bindAddress:
            frame >= sshTiming.network ? "192.168.1.42" : "127.0.0.1",
          addresses: ["192.168.1.42"],
          keys: [],
          state: frame >= sshTiming.local ? "listening" : "disabled",
          message: null,
          fingerprint: null,
        },
      ],
    };
  }
  const pageActions =
    page === "ssh"
      ? {
          ...actions,
          saveSshAccess: async () => undefined,
          sshConnection: async () => null,
        }
      : actions;
  if (page === "network" && frame < 35 && source.network)
    source.network.workspaces[0].ports = [];
  const section = page === "network" || page === "files" ? page : "overview";
  let body: ReactNode;
  if (page === "computers")
    body = (
      <div className="p-6">
        <RemoteComputersSettings
          source={{ ...source, remoteComputers: [], workspaces: [] }}
          actions={actions}
        />
      </div>
    );
  else if (page === "connect" && !connected)
    body = (
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <RecordedConnection key={frame} frame={frame} />
      </div>
    );
  else if (page === "files")
    body = (
      <WorkspacesPage
        section="files"
        onSectionChange={noop}
        workspaces={[
          {
            ...demo,
            repositories: [
              {
                path: "/workspace/hello-silo",
                branch: "main",
                ahead: 0,
                behind: 0,
                dirty: false,
              },
            ],
          },
        ]}
        editor="Zed"
        browser="Safari"
        onOpenEditor={noop}
        directoryStore={directoryStore}
        active={true}
        activities={[]}
        selectedWorkspaceIds={new Set()}
        logQuery=""
        repositoryPushOperations={[]}
        networkActions={actions}
        onWorkspaceFilterChange={noop}
        onLogQueryChange={noop}
        onPushRepository={noop}
        onDismissRepositoryPush={noop}
      />
    );
  else if (page === "network")
    body = (
      <div className="p-6">
        <h2 className="mb-4 text-xs font-medium">Network</h2>
        <NetworkPage
          workspaces={[demo]}
          browser="Safari"
          network={source.network}
          actions={actions}
          active={false}
        />
      </div>
    );
  else
    body = (
      <OverviewPage
        source={source}
        actions={pageActions}
        onMachinesChange={noop}
      />
    );
  return (
    <div ref={surface} className="product-surface">
      <SettingsProvider initialSettings={source.preferences}>
        <TooltipProvider>
          <ApplicationShell
            key={page === "computers" ? "settings" : "workspaces"}
            activeTab={page === "computers" ? "settings" : "workspaces"}
            workspaceSection={section}
            settingsSection="computers"
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
            {body}
          </ApplicationShell>
        </TooltipProvider>
      </SettingsProvider>
    </div>
  );
}

function RecordedConnection({ frame }: { frame: number }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const handle = delayRender("Set production connection field");
    const input = root.current?.querySelector<HTMLInputElement>(
      '[aria-label="Computer address"]',
    );
    if (input) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, pastedAddress(office.address, frame));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    let second = 0;
    const first = requestAnimationFrame(() => {
      if (frame >= 155)
        root.current?.querySelector<HTMLFormElement>("form")?.requestSubmit();
      second = requestAnimationFrame(() => continueRender(handle));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      continueRender(handle);
    };
  }, [frame]);
  return (
    <div ref={root}>
      <ConnectComputerForm
        connect={() => new Promise<void>(() => {})}
        onClose={noop}
      />
    </div>
  );
}
