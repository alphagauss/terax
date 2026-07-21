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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { remoteNative } from "./native";
import { applyCredentialMutation, credentialMutation } from "./profileForm";
import { useRemoteStore } from "./store";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string | null;
  onConnected: () => Promise<string | null>;
};

export function SshConnectionDialog({
  open,
  onOpenChange,
  profileId,
  onConnected,
}: Props) {
  const { t } = useTranslation("statusbar");
  const profiles = useRemoteStore((state) => state.profiles);
  const load = useRemoteStore((state) => state.load);
  const setStatus = useRemoteStore((state) => state.setStatus);
  const profile = useMemo(
    () => profiles.find((item) => item.id === profileId) ?? null,
    [profileId, profiles],
  );
  const [secret, setSecret] = useState("");
  const [secretDirty, setSecretDirty] = useState(false);
  const [proxySecret, setProxySecret] = useState("");
  const [proxySecretDirty, setProxySecretDirty] = useState(false);
  const [rememberSecret, setRememberSecret] = useState(true);
  const [rememberProxySecret, setRememberProxySecret] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !profileId) return;
    let active = true;
    setReady(false);
    setError(null);
    setSecret("");
    setSecretDirty(false);
    setProxySecret("");
    setProxySecretDirty(false);
    setRememberSecret(true);
    setRememberProxySecret(true);
    void (async () => {
      try {
        const loaded = await load();
        const loadedProfile = loaded.find((item) => item.id === profileId);
        if (!loadedProfile) {
          if (active) setError(t("sshConnection.profileMissing"));
          return;
        }
        const [savedSecret, savedProxySecret] = await Promise.all([
          loadedProfile.authMethod === "agent"
            ? null
            : remoteNative.getSecret(profileId),
          loadedProfile.proxyUrl
            ? remoteNative.getProxySecret(profileId)
            : null,
        ]);
        if (active) {
          setSecret(savedSecret ?? "");
          setProxySecret(savedProxySecret ?? "");
        }
      } catch (cause) {
        if (active) setError(String(cause));
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [load, open, profileId, t]);

  const persistSecrets = async () => {
    if (!profile) return;
    await applyCredentialMutation(
      credentialMutation({
        value: secret,
        dirty: secretDirty,
        remember: rememberSecret,
        applicable: profile.authMethod !== "agent",
      }),
      (value) => remoteNative.setSecret(profile.id, value),
      () => remoteNative.deleteAuthSecret(profile.id),
    );
    await applyCredentialMutation(
      credentialMutation({
        value: proxySecret,
        dirty: proxySecretDirty,
        remember: rememberProxySecret,
        applicable: Boolean(profile.proxyUrl),
      }),
      (value) => remoteNative.setProxySecret(profile.id, value),
      () => remoteNative.deleteProxySecret(profile.id),
    );
  };

  const connect = async () => {
    if (!profile) {
      setError(t("sshConnection.profileMissing"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await persistSecrets();
      const info = await remoteNative.connect(
        profile,
        secret || null,
        proxySecret || null,
      );
      setStatus(info);
      if (!(await onConnected())) {
        throw new Error(t("sshConnection.homeError"));
      }
      onOpenChange(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const passwordLabel =
    profile?.authMethod === "private_key"
      ? t("sshConnection.passphrase")
      : t("sshConnection.password");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sshConnection.title")}</DialogTitle>
          <DialogDescription>
            {profile
              ? t("sshConnection.description", { name: profile.name })
              : t("sshConnection.profileMissing")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {profile?.authMethod === "agent" ? (
            <p className="rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
              {t("sshConnection.agent")}
            </p>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-connection-secret">{passwordLabel}</Label>
              <Input
                id="ssh-connection-secret"
                type="password"
                disabled={!ready || busy || !profile}
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setSecretDirty(true);
                }}
                autoComplete="off"
              />
              <SecretToggle
                id="ssh-connection-remember-secret"
                checked={rememberSecret}
                onCheckedChange={setRememberSecret}
                label={t("sshConnection.rememberSecret")}
              />
            </div>
          )}

          {profile?.proxyUrl ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-connection-proxy-secret">
                {t("sshConnection.proxyPassword")}
              </Label>
              <Input
                id="ssh-connection-proxy-secret"
                type="password"
                disabled={!ready || busy}
                value={proxySecret}
                onChange={(event) => {
                  setProxySecret(event.target.value);
                  setProxySecretDirty(true);
                }}
                autoComplete="off"
              />
              <SecretToggle
                id="ssh-connection-remember-proxy-secret"
                checked={rememberProxySecret}
                onCheckedChange={setRememberProxySecret}
                label={t("sshConnection.rememberProxySecret")}
              />
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={!ready || busy || !profile}
            onClick={() => void connect()}
          >
            {busy ? t("sshConnection.connecting") : t("sshConnection.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretToggle({
  id,
  checked,
  onCheckedChange,
  label,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label
        htmlFor={id}
        className="text-[11px] font-normal text-muted-foreground"
      >
        {label}
      </Label>
    </div>
  );
}
