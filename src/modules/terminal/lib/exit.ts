export const REMOTE_TRANSPORT_CLOSED_EXIT_CODE = -255;

export function isRecoverableRemoteExit(code: number): boolean {
  return code === REMOTE_TRANSPORT_CLOSED_EXIT_CODE;
}
