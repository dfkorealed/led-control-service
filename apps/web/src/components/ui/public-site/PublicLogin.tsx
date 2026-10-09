import { Button } from "../Button";
import { LinkButton } from "../LinkButton";
import { getPublicServiceUrl } from "../../../features/landing/public-service-url";

export function PublicLogin() {
  const serviceUrl = getPublicServiceUrl(import.meta.env.VITE_LANDING_SERVICE_URL);
  if (serviceUrl) return <LinkButton href={serviceUrl} variant="landingHeader" className="button--header">로그인 <span aria-hidden="true">↗</span></LinkButton>;
  return <Button type="button" variant="landingHeader" className="button--header" disabled>준비 중</Button>;
}
