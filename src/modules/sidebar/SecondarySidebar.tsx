import type { ReactNode } from "react";
import { SidebarViewRail, type SidebarRailItem } from "./SidebarRail";

export type SecondarySidebarView = SidebarRailItem & {
  content: ReactNode;
};

type Props = {
  views: readonly SecondarySidebarView[];
  activeView: string | null;
  onSelectView: (view: string) => void;
};

export function SecondarySidebar({ views, activeView, onSelectView }: Props) {
  const selected = views.find((view) => view.id === activeView) ?? views[0];
  if (!selected) return null;

  return (
    <aside className="sidebar-scrollbar-scope flex h-full min-h-0 flex-col border-l border-border/60 bg-sidebar">
      {views.length > 1 ? (
        <SidebarViewRail
          items={views}
          activeView={selected.id}
          onSelectView={onSelectView}
        />
      ) : null}
      <div key={selected.id} className="min-h-0 flex-1">
        {selected.content}
      </div>
    </aside>
  );
}
