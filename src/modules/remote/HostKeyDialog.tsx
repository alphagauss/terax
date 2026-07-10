import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { remoteNative } from "./native";
import type { HostKeyPrompt } from "./types";

type Props = {
  prompt: HostKeyPrompt | null;
  onResolved: () => void;
};

export function HostKeyDialog({ prompt, onResolved }: Props) {
  const [remember, setRemember] = useState(true);

  const resolve = async (accepted: boolean) => {
    if (!prompt) return;
    try {
      await remoteNative.confirmHostKey(prompt.requestId, accepted, remember);
    } finally {
      setRemember(true);
      onResolved();
    }
  };

  return (
    <AlertDialog open={prompt !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {prompt?.changed ? "Remote host key changed" : "Trust remote host?"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-left">
              <p>
                {prompt?.changed
                  ? "The saved key no longer matches. Verify the fingerprint before continuing; this can indicate a man-in-the-middle attack."
                  : "This host has not been seen before. Verify its fingerprint before connecting."}
              </p>
              <div className="rounded-md bg-muted/70 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                <div>
                  {prompt?.host}:{prompt?.port} ({prompt?.keyType})
                </div>
                <div className="break-all">{prompt?.fingerprint}</div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="ssh-remember-host-key"
                  checked={remember}
                  onCheckedChange={(value) => setRemember(value === true)}
                />
                <Label htmlFor="ssh-remember-host-key">
                  Remember this key for future connections
                </Label>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void resolve(false)}>
            Cancel connection
          </AlertDialogCancel>
          <AlertDialogAction
            variant={prompt?.changed ? "destructive" : "default"}
            onClick={() => void resolve(true)}
          >
            {prompt?.changed ? "Trust changed key" : "Trust and connect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
