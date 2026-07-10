import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { remoteNative } from "./native";
import { newProfileId, useRemoteStore } from "./store";
import type {
  ConnectionInfo,
  SshAuthMethod,
  SshProfile,
  TunnelInfo,
  TunnelKind,
} from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (profile: SshProfile) => void | Promise<void>;
};

type Form = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: SshAuthMethod;
  identityFile: string;
  secret: string;
  rememberSecret: boolean;
  proxyUrl: string;
  proxySecret: string;
  rememberProxySecret: boolean;
  keepaliveSeconds: string;
  reconnectEnabled: boolean;
  reconnectMaxAttempts: string;
  rootPath: string;
};

const emptyForm = (): Form => ({
  id: newProfileId(),
  name: "",
  host: "",
  port: "22",
  username: "",
  authMethod: "password",
  identityFile: "",
  secret: "",
  rememberSecret: true,
  proxyUrl: "",
  proxySecret: "",
  rememberProxySecret: true,
  keepaliveSeconds: "30",
  reconnectEnabled: true,
  reconnectMaxAttempts: "5",
  rootPath: "~",
});

function formFromProfile(profile: SshProfile): Form {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    identityFile: profile.identityFile ?? "",
    secret: "",
    rememberSecret: true,
    proxyUrl: profile.proxyUrl ?? "",
    proxySecret: "",
    rememberProxySecret: true,
    keepaliveSeconds: String(profile.keepaliveSeconds),
    reconnectEnabled: profile.reconnectEnabled,
    reconnectMaxAttempts: String(profile.reconnectMaxAttempts),
    rootPath: profile.rootPath ?? "~",
  };
}

function profileFromForm(form: Form): SshProfile {
  const host = form.host.trim();
  const username = form.username.trim();
  return {
    id: form.id,
    name: form.name.trim() || `${username}@${host}`,
    host,
    port: Number(form.port) || 22,
    username,
    authMethod: form.authMethod,
    identityFile: form.identityFile.trim() || null,
    proxyUrl: form.proxyUrl.trim() || null,
    keepaliveSeconds: Math.max(0, Number(form.keepaliveSeconds) || 0),
    reconnectEnabled: form.reconnectEnabled,
    reconnectMaxAttempts: Math.max(1, Number(form.reconnectMaxAttempts) || 5),
    rootPath: form.rootPath.trim() || "~",
  };
}

function proxyUrlContainsPassword(value: string): boolean {
  const authority = value.split("://", 2)[1]?.split("/", 1)[0] ?? "";
  const userInfo = authority.includes("@")
    ? authority.slice(0, authority.lastIndexOf("@"))
    : "";
  const separator = userInfo.indexOf(":");
  return separator >= 0 && userInfo.slice(separator + 1).length > 0;
}

export function RemoteSshDialog({ open, onOpenChange, onConnected }: Props) {
  const profiles = useRemoteStore((state) => state.profiles);
  const statuses = useRemoteStore((state) => state.statuses);
  const load = useRemoteStore((state) => state.load);
  const saveProfile = useRemoteStore((state) => state.saveProfile);
  const saveProfiles = useRemoteStore((state) => state.saveProfiles);
  const deleteProfile = useRemoteStore((state) => state.deleteProfile);
  const setStatus = useRemoteStore((state) => state.setStatus);

  const [form, setForm] = useState<Form>(emptyForm);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState<"connection" | "tunnels">("connection");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [tunnelKind, setTunnelKind] = useState<TunnelKind>("local");
  const [tunnelName, setTunnelName] = useState("");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState("0");
  const [targetHost, setTargetHost] = useState("localhost");
  const [targetPort, setTargetPort] = useState("");

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );
  const status = selectedId ? statuses[selectedId] : undefined;

  const selectProfile = useCallback(async (profile: SshProfile) => {
    setSelectedId(profile.id);
    setForm(formFromProfile(profile));
    setError(null);
    const [secret, proxySecret] = await Promise.all([
      remoteNative.getSecret(profile.id).catch(() => null),
      remoteNative.getProxySecret(profile.id).catch(() => null),
    ]);
    if (secret !== null || proxySecret !== null) {
      setForm((current) =>
        current.id === profile.id
          ? {
              ...current,
              secret: secret ?? current.secret,
              proxySecret: proxySecret ?? current.proxySecret,
            }
          : current,
      );
    }
  }, []);

  const refreshTunnels = useCallback(async (profileId: string) => {
    const items = await remoteNative.listTunnels(profileId).catch(() => []);
    setTunnels(items);
  }, []);

  useEffect(() => {
    if (!open) return;
    void load().then((loaded) => {
      if (selectedId || loaded.length === 0) return;
      void selectProfile(loaded[0]);
    });
  }, [open, load, selectedId, selectProfile]);

  useEffect(() => {
    if (!open || page !== "tunnels" || !selectedId) return;
    void refreshTunnels(selectedId);
  }, [open, page, selectedId, refreshTunnels]);

  const startNew = () => {
    setSelectedId(null);
    setForm(emptyForm());
    setPage("connection");
    setError(null);
  };

  const connect = async () => {
    const profile = profileFromForm(form);
    if (!profile.host || !profile.username) {
      setError("Host and username are required.");
      return;
    }
    if (profile.authMethod === "private_key" && !profile.identityFile) {
      setError("Choose a private key file path.");
      return;
    }
    if (profile.proxyUrl && proxyUrlContainsPassword(profile.proxyUrl)) {
      setError(
        "Do not put a password in the proxy URL. Enter it in the secure proxy-password field.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveProfile(profile);
      if (form.rememberSecret && form.secret) {
        await remoteNative.setSecret(profile.id, form.secret);
      } else if (!form.rememberSecret) {
        await remoteNative.deleteSecret(profile.id).catch(() => {});
      }
      if (profile.proxyUrl && form.rememberProxySecret && form.proxySecret) {
        await remoteNative.setProxySecret(profile.id, form.proxySecret);
      } else if (!profile.proxyUrl || !form.rememberProxySecret) {
        await remoteNative.deleteProxySecret(profile.id).catch(() => {});
      }
      const info = await remoteNative.connect(
        profile,
        form.secret,
        form.proxySecret,
      );
      setStatus(info);
      await onConnected(profile);
      onOpenChange(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await remoteNative.disconnect(selected.id);
      setStatus({ profileId: selected.id, status: "disconnected" });
    } finally {
      setBusy(false);
    }
  };

  const importConfig = async () => {
    setBusy(true);
    try {
      const imported = await remoteNative.importConfig();
      const existing = new Set(
        profiles.map(
          (profile) => `${profile.username}@${profile.host}:${profile.port}`,
        ),
      );
      const additions = imported
        .filter(
          (host) => !existing.has(`${host.user}@${host.hostname}:${host.port}`),
        )
        .map(
          (host): SshProfile => ({
            id: newProfileId(),
            name: host.alias,
            host: host.hostname,
            port: host.port,
            username: host.user,
            authMethod: host.identityFile ? "private_key" : "agent",
            identityFile: host.identityFile || null,
            proxyUrl: null,
            keepaliveSeconds: 30,
            reconnectEnabled: true,
            reconnectMaxAttempts: 5,
            rootPath: null,
          }),
        );
      await saveProfiles(additions);
      toast.success(
        additions.length
          ? `Imported ${additions.length} SSH profile(s)`
          : "No new SSH profiles found",
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = async () => {
    if (!selected || !window.confirm(`Delete SSH profile “${selected.name}”?`))
      return;
    await deleteProfile(selected.id);
    startNew();
  };

  const startTunnel = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await remoteNative.startTunnel({
        profileId: selected.id,
        name: tunnelName.trim() || `${tunnelKind} ${bindPort}`,
        kind: tunnelKind,
        bindHost: bindHost.trim() || "127.0.0.1",
        bindPort: Number(bindPort) || 0,
        targetHost: tunnelKind === "dynamic" ? "" : targetHost.trim(),
        targetPort: tunnelKind === "dynamic" ? 0 : Number(targetPort) || 0,
      });
      await refreshTunnels(selected.id);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(720px,calc(100vh-3rem))] max-w-5xl grid-rows-[auto_1fr_auto] overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Remote SSH</DialogTitle>
          <DialogDescription>
            Connect a complete Terax workspace to a remote SSH host.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[220px_1fr]">
          <aside className="flex min-h-0 flex-col border-r bg-muted/20">
            <div className="flex gap-2 border-b p-3">
              <Button size="sm" className="flex-1" onClick={startNew}>
                New
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void importConfig()}
              >
                Import
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {profiles.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  No saved hosts yet.
                </p>
              ) : (
                profiles.map((profile) => {
                  const itemStatus = statuses[profile.id]?.status;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => void selectProfile(profile)}
                      className={cn(
                        "mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent",
                        selectedId === profile.id && "bg-accent",
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 rounded-full bg-muted-foreground/40",
                          itemStatus === "connected" && "bg-emerald-500",
                          (itemStatus === "connecting" ||
                            itemStatus === "reconnecting") &&
                            "bg-amber-500",
                          itemStatus === "error" && "bg-destructive",
                        )}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">
                          {profile.name}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {profile.username}@{profile.host}:{profile.port}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto px-6 py-5">
            <div className="mb-5 flex items-center gap-2 border-b">
              {(["connection", "tunnels"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  disabled={item === "tunnels" && !selected}
                  onClick={() => setPage(item)}
                  className={cn(
                    "border-b-2 border-transparent px-3 py-2 text-sm capitalize text-muted-foreground",
                    page === item && "border-primary text-foreground",
                  )}
                >
                  {item}
                </button>
              ))}
              {status ? (
                <span className="ml-auto text-xs capitalize text-muted-foreground">
                  {status.status.replace("_", " ")}
                </span>
              ) : null}
            </div>

            {page === "connection" ? (
              <ConnectionForm form={form} setForm={setForm} />
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3 rounded-lg border p-4">
                  <Field label="Name">
                    <Input
                      value={tunnelName}
                      onChange={(event) => setTunnelName(event.target.value)}
                      placeholder="Development server"
                    />
                  </Field>
                  <Field label="Type">
                    <select
                      value={tunnelKind}
                      onChange={(event) =>
                        setTunnelKind(event.target.value as TunnelKind)
                      }
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="local">Local (-L)</option>
                      <option value="remote">Remote (-R)</option>
                      <option value="dynamic">Dynamic SOCKS (-D)</option>
                    </select>
                  </Field>
                  <Field label="Bind address">
                    <Input
                      value={bindHost}
                      onChange={(event) => setBindHost(event.target.value)}
                    />
                  </Field>
                  <Field label="Bind port (0 = automatic)">
                    <Input
                      type="number"
                      value={bindPort}
                      onChange={(event) => setBindPort(event.target.value)}
                    />
                  </Field>
                  {tunnelKind !== "dynamic" ? (
                    <>
                      <Field label="Target host">
                        <Input
                          value={targetHost}
                          onChange={(event) =>
                            setTargetHost(event.target.value)
                          }
                        />
                      </Field>
                      <Field label="Target port">
                        <Input
                          type="number"
                          value={targetPort}
                          onChange={(event) =>
                            setTargetPort(event.target.value)
                          }
                        />
                      </Field>
                    </>
                  ) : null}
                  <div className="col-span-2 flex justify-end">
                    <Button
                      disabled={busy || status?.status !== "connected"}
                      onClick={() => void startTunnel()}
                    >
                      Start tunnel
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  {tunnels.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No active tunnels for this profile.
                    </p>
                  ) : (
                    tunnels.map((tunnel) => (
                      <div
                        key={tunnel.id}
                        className="flex items-center gap-3 rounded-md border px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{tunnel.name}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {tunnel.kind} {tunnel.bindHost}:{tunnel.bindPort}
                            {tunnel.kind !== "dynamic"
                              ? ` → ${tunnel.targetHost}:${tunnel.targetPort}`
                              : " (SOCKS5)"}
                          </div>
                        </div>
                        <span className="text-[10px] capitalize text-muted-foreground">
                          {tunnel.status}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void remoteNative
                              .stopTunnel(tunnel.id)
                              .then(
                                () => selected && refreshTunnels(selected.id),
                              )
                          }
                        >
                          Stop
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {error ? (
              <div className="mt-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
          </main>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          {selected ? (
            <Button variant="ghost" onClick={() => void removeSelected()}>
              Delete profile
            </Button>
          ) : null}
          <div className="flex-1" />
          {status?.status === "connected" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          ) : null}
          <Button
            disabled={busy || page !== "connection"}
            onClick={() => void connect()}
          >
            {busy ? "Connecting…" : "Connect workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionForm({
  form,
  setForm,
}: {
  form: Form;
  setForm: React.Dispatch<React.SetStateAction<Form>>;
}) {
  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4">
      <Field label="Profile name" className="col-span-2">
        <Input
          value={form.name}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Production server"
        />
      </Field>
      <Field label="Host">
        <Input
          value={form.host}
          onChange={(event) => update("host", event.target.value)}
          placeholder="server.example.com"
        />
      </Field>
      <Field label="Port">
        <Input
          type="number"
          min={1}
          max={65535}
          value={form.port}
          onChange={(event) => update("port", event.target.value)}
        />
      </Field>
      <Field label="Username">
        <Input
          value={form.username}
          onChange={(event) => update("username", event.target.value)}
        />
      </Field>
      <Field label="Authentication">
        <select
          value={form.authMethod}
          onChange={(event) =>
            update("authMethod", event.target.value as SshAuthMethod)
          }
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="password">Password</option>
          <option value="private_key">Private key</option>
          <option value="agent">SSH agent</option>
        </select>
      </Field>
      {form.authMethod === "private_key" ? (
        <Field label="Private key path" className="col-span-2">
          <Input
            value={form.identityFile}
            onChange={(event) => update("identityFile", event.target.value)}
            placeholder="~/.ssh/id_ed25519"
          />
        </Field>
      ) : null}
      {form.authMethod !== "agent" ? (
        <Field
          label={form.authMethod === "password" ? "Password" : "Passphrase"}
          className="col-span-2"
        >
          <Input
            type="password"
            value={form.secret}
            onChange={(event) => update("secret", event.target.value)}
            autoComplete="off"
          />
          <div className="mt-2 flex items-center gap-2">
            <Checkbox
              id="ssh-remember-secret"
              checked={form.rememberSecret}
              onCheckedChange={(value) =>
                update("rememberSecret", value === true)
              }
            />
            <Label
              htmlFor="ssh-remember-secret"
              className="text-xs font-normal text-muted-foreground"
            >
              Store securely in the operating system credential vault
            </Label>
          </div>
        </Field>
      ) : null}
      <Field label="Remote workspace root">
        <Input
          value={form.rootPath}
          onChange={(event) => update("rootPath", event.target.value)}
          placeholder="~"
        />
      </Field>
      <Field label="Keepalive seconds">
        <Input
          type="number"
          min={0}
          value={form.keepaliveSeconds}
          onChange={(event) => update("keepaliveSeconds", event.target.value)}
        />
      </Field>
      <Field label="Outbound proxy URL" className="col-span-2">
        <Input
          value={form.proxyUrl}
          onChange={(event) => update("proxyUrl", event.target.value)}
          placeholder="socks5://user@127.0.0.1:1080 or https://proxy:443"
        />
      </Field>
      {form.proxyUrl.trim() ? (
        <Field label="Proxy password" className="col-span-2">
          <Input
            type="password"
            value={form.proxySecret}
            onChange={(event) => update("proxySecret", event.target.value)}
            autoComplete="off"
            placeholder="Stored in the operating-system credential vault"
          />
          <div className="mt-2 flex items-center gap-2">
            <Checkbox
              id="ssh-remember-proxy-secret"
              checked={form.rememberProxySecret}
              onCheckedChange={(value) =>
                update("rememberProxySecret", value === true)
              }
            />
            <Label
              htmlFor="ssh-remember-proxy-secret"
              className="text-xs font-normal text-muted-foreground"
            >
              Remember proxy password securely
            </Label>
          </div>
        </Field>
      ) : null}
      <div className="col-span-2 flex items-center gap-3 rounded-md border px-3 py-2">
        <Checkbox
          checked={form.reconnectEnabled}
          onCheckedChange={(value) =>
            update("reconnectEnabled", value === true)
          }
        />
        <span className="flex-1 text-sm">Reconnect automatically</span>
        <Label htmlFor="ssh-reconnect-attempts" className="text-xs">
          Attempts
        </Label>
        <Input
          id="ssh-reconnect-attempts"
          type="number"
          min={1}
          max={20}
          className="w-20"
          disabled={!form.reconnectEnabled}
          value={form.reconnectMaxAttempts}
          onChange={(event) =>
            update("reconnectMaxAttempts", event.target.value)
          }
        />
      </div>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // Biome cannot see that each caller renders a native input/select inside
    // this wrapper. Keeping the label wrapper preserves click-to-focus.
    // biome-ignore lint/a11y/noLabelWithoutControl: control is supplied through children
    <label className={cn("grid gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function statusLabel(info?: ConnectionInfo): string {
  if (!info) return "Disconnected";
  return info.status.replace("_", " ");
}
