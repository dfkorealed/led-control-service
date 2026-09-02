import type { ReactNode } from "react";

export function PageHeader({ title, description, status, actions }: { title: string; description?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return <header className="ui-page-header"><div><h2>{title}</h2>{description ? <div className="ui-page-description">{description}</div> : null}</div>{status || actions ? <div className="ui-page-actions">{status}{actions}</div> : null}</header>;
}
