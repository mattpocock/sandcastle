import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { connectFleetSocket } from "./api/ws";
import { DeployChordOverlay } from "./primitives/DeployChordOverlay";
import { FleetDock } from "./primitives/FleetDock";
import { useFleetStore } from "./state/fleetStore";

export function AppChrome(): JSX.Element {
  const [deployOpen, setDeployOpen] = useState(false);
  const setConnectionState = useFleetStore((state) => state.setConnectionState);

  useEffect(() => {
    const disconnect = connectFleetSocket(
      window.sandcastle,
      useFleetStore.getState().applyServerMessage,
    );
    return disconnect;
  }, []);

  useEffect(() => {
    const open = (): void => setDeployOpen(true);
    const keydown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setDeployOpen(true);
      }
      if (event.key === "Escape") setDeployOpen(false);
    };

    window.addEventListener("sandcastle:open-deploy", open);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("sandcastle:open-deploy", open);
      window.removeEventListener("keydown", keydown);
      setConnectionState("closed");
    };
  }, [setConnectionState]);

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-cluster">
          <span className="traffic" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-mark">S</span>
          <span className="brand-word">Sandcastle</span>
          <span className="brand-context">Cockpit MVP</span>
        </div>
        <div className="titlebar-center">local control link</div>
        <div className="titlebar-right">
          <span className="mono-chip">
            127.0.0.1:{window.sandcastle.port || "..."}
          </span>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <FleetDock onDeploy={() => setDeployOpen(true)} />
      <DeployChordOverlay open={deployOpen} onOpenChange={setDeployOpen} />
    </div>
  );
}
