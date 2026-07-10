export type TreeRequestIdentity = {
  scope: string;
  generation: number;
  id: number;
};

export function isCurrentTreeRequest(
  request: TreeRequestIdentity,
  activeScope: string,
  activeGeneration: number,
  activeId: number | undefined,
): boolean {
  return (
    request.scope === activeScope &&
    request.generation === activeGeneration &&
    request.id === activeId
  );
}
