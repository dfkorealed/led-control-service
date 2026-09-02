import type { ReactNode } from "react";

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export function PageHeader({ title, description, status, actions, headingLevel = 2 }: { title: string; description?: ReactNode; status?: ReactNode; actions?: ReactNode; headingLevel?: HeadingLevel }) {
  const Heading = `h${headingLevel}` as keyof JSX.IntrinsicElements;
  return <header className="ui-page-header"><div><Heading>{title}</Heading>{description ? <div className="ui-page-description">{description}</div> : null}</div>{status || actions ? <div className="ui-page-actions">{status}{actions}</div> : null}</header>;
}
