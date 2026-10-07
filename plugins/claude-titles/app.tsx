// Saving an empty thread name (sidebar or thread header) normally fails with
// "Name cannot be empty.". This content script catches that save first, closes
// the editor and has the server write a title with Claude instead.
//
// The rename editors belong to bb, so the script recognizes them by their
// accessible label. Content scripts get no RPC client, so a render-nothing
// overlay hands its `useRpc` client to the script through module state.
import { definePluginApp, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { toast } from "sonner";
import type { rpcContract } from "./server";

type Rpc = PluginRpcClient<typeof rpcContract>;

const THREAD_NAME_LABEL = "Thread name";
const THREAD_ID_PATTERN = /^thr_[A-Za-z0-9]+$/;

let rpc: Rpc | null = null;

function RpcBridge() {
  const client = useRpc<typeof rpcContract>();
  useEffect(() => {
    rpc = client;
    return () => {
      if (rpc === client) rpc = null;
    };
  }, [client]);
  return null;
}

function emptyThreadNameInput(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement)) return null;
  if (target.getAttribute("aria-label") !== THREAD_NAME_LABEL) return null;
  return target.value.trim() === "" ? target : null;
}

/** The sidebar row's thread link, else the thread open in the current route. */
function threadIdFor(input: HTMLInputElement): string | null {
  const row = input.closest("[data-sidebar-rename-row]");
  const fromRow = row
    ?.querySelector<HTMLElement>("[data-sidebar-thread-id]")
    ?.dataset.sidebarThreadId;
  if (fromRow && THREAD_ID_PATTERN.test(fromRow)) return fromRow;
  if (row) return null;
  const fromRoute = window.location.pathname.match(/thr_[A-Za-z0-9]+/u)?.[0];
  return fromRoute ?? null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "rpc-bridge", component: RpcBridge });

  app.contentScripts.register({
    id: "empty-name-retitle",
    mount({ signal, experimental_setThreadRowStatus: setRowStatus }) {
      const handled = new WeakSet<HTMLInputElement>();
      const inFlight = new Set<string>();

      async function retitle(client: Rpc, threadId: string) {
        inFlight.add(threadId);
        setRowStatus?.(threadId, {
          icon: "Sparkles",
          label: "Generating title",
          tone: "running",
        });
        try {
          await client.call("retitle", { threadId });
        } catch (error) {
          if (!signal.aborted) {
            toast.error("Couldn't generate a title", {
              description: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          inFlight.delete(threadId);
          if (!signal.aborted) setRowStatus?.(threadId, null);
        }
      }

      // Returns true when the save was taken over; bb's handler must not run.
      function takeOver(input: HTMLInputElement): boolean {
        if (handled.has(input)) return true;
        const client = rpc;
        const threadId = threadIdFor(input);
        if (!client || !threadId) return false;
        handled.add(input);
        // bb's editor cancels on Escape, keeping the current title meanwhile.
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        if (!inFlight.has(threadId)) void retitle(client, threadId);
        return true;
      }

      // Capture on document runs before React's listeners on the app root.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" || event.isComposing) return;
        const input = emptyThreadNameInput(event.target);
        if (input && takeOver(input)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      const onFocusOut = (event: FocusEvent) => {
        const input = emptyThreadNameInput(event.target);
        if (input && takeOver(input)) event.stopImmediatePropagation();
      };

      document.addEventListener("keydown", onKeyDown, { capture: true, signal });
      document.addEventListener("focusout", onFocusOut, { capture: true, signal });
    },
  });
});
