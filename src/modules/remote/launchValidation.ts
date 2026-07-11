type LaunchSecretState = {
  launchOnly: boolean;
  secret: string;
  rememberSecret: boolean;
  proxySecret: string;
  rememberProxySecret: boolean;
};

export function launchOnlySecretError({
  launchOnly,
  secret,
  rememberSecret,
  proxySecret,
  rememberProxySecret,
}: LaunchSecretState): string | null {
  if (!launchOnly) return null;
  if (secret && !rememberSecret) {
    return "A separate Workspace cannot receive this password on the command line. Enable secure storage, or clear the field and enter it in the SSH window.";
  }
  if (proxySecret && !rememberProxySecret) {
    return "Opening a separate Workspace requires the proxy password to be stored securely.";
  }
  return null;
}
