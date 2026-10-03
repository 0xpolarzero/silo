import { useLayoutEffect, useRef, type ReactNode } from "react";
import { delayRender, continueRender } from "remotion";
import { ApplicationShell } from "@/features/application/components/application-shell";
import { OverviewPage } from "@/features/application/pages/overview-page";
import {
  ConnectDeviceForm,
  ConnectionsSettings,
} from "@/features/application/components/connections-settings";
import { NetworkPage } from "@/features/application/pages/network-page";
import { SettingsProvider } from "@/features/preferences/settings-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { computerTarget } from "@/features/application/model/connections";
import { actions, demo, noop, office, sourceFor } from "./fixtures";
import { sshTiming } from "./ssh-timeline";
import { pastedAddress } from "./timeline";
import { ComputersPage } from "@/features/application/pages/computers-page";
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

type Page = "ssh" | "overview" | "connections" | "connect" | "network" | "files";
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
    enabled: page === "connections" && frame >= 90,
    starting: page === "connect",
    portConnected: page !== "network" || frame >= 110,
  });
  if (page === "ssh") {
    source.computers = [demo];
    source.sshAccess = {
      computers: [
        {
          computer: computerTarget(demo),
          deviceName: "Office Mac",
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
    source.network.computers[0].ports = [];
  const section = page === "network" || page === "files" ? page : "overview";
  let body: ReactNode;
  if (page === "connections")
    body = (
      <div className="p-6">
        <ConnectionsSettings
          source={{ ...source, devices: [], computers: [] }}
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
      <ComputersPage
        source={source}
        section="files"
        onSectionChange={noop}
        computers={[
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
        selectedComputerIds={new Set()}
        logQuery=""
        repositoryPushOperations={[]}
        networkActions={actions}
        onComputerFilterChange={noop}
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
          computers={[demo]}
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
        onConfigurationsChange={noop}
      />
    );
  return (
    <div ref={surface} className="product-surface">
      <SettingsProvider initialSettings={source.preferences}>
        <TooltipProvider>
          <ApplicationShell
            key={page === "connections" ? "settings" : "computers"}
            activeTab={page === "connections" ? "settings" : "computers"}
            computerSection={section}
            settingsSection="connections"
            systemIssueStatus={null}
            computerAttention={{ errors: 0, warnings: 0 }}
            onTabChange={noop}
            onComputerSectionChange={noop}
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
      '[aria-label="Device address"]',
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
      <ConnectDeviceForm
        connect={() => new Promise<void>(() => {})}
        onClose={noop}
      />
    </div>
  );
}
