import {
  fixtureRegistrationRemovalPreviewSchema, fixtureRegistrationRemovalRequestSchema,
  fixtureRegistrationRemovalViewSchema,
  type FixtureRegistrationRemovalRequest, type FixtureRegistrationRemovalView
} from "@led-control/shared/fixture-registration-removal-contracts";
import { apiGet, apiPost, type ApiRequestOptions } from "./client";

export interface FixtureRemovalScope { siteId: string; floorId: string; fixtureId: string }

function fixturePath(scope: FixtureRemovalScope) {
  return `/sites/${encodeURIComponent(scope.siteId)}/floors/${encodeURIComponent(scope.floorId)}/fixtures/${encodeURIComponent(scope.fixtureId)}`;
}

function parseView(value: unknown, scope: FixtureRemovalScope, operationId?: string): FixtureRegistrationRemovalView {
  const view = fixtureRegistrationRemovalViewSchema.parse(value);
  if (view.siteId !== scope.siteId || view.floorId !== scope.floorId || view.fixtureId !== scope.fixtureId
    || (operationId !== undefined && view.operationId !== operationId)) throw new Error("Removal response identity mismatch");
  return view;
}

export async function getFixtureRegistrationRemovalPreview(scope: FixtureRemovalScope, options?: ApiRequestOptions) {
  const preview = fixtureRegistrationRemovalPreviewSchema.parse(await apiGet<unknown>(`${fixturePath(scope)}/registration-removal-preview`, options));
  if (preview.fixtureId !== scope.fixtureId) throw new Error("Removal preview identity mismatch");
  return preview;
}

export async function requestFixtureRegistrationRemoval(scope: FixtureRemovalScope, input: FixtureRegistrationRemovalRequest, options?: ApiRequestOptions) {
  const body = fixtureRegistrationRemovalRequestSchema.parse(input);
  return parseView(await apiPost<unknown>(`${fixturePath(scope)}/registration-removals`, body, options), scope);
}

export async function getFixtureRegistrationRemoval(scope: FixtureRemovalScope, operationId: string, options?: ApiRequestOptions) {
  return parseView(await apiGet<unknown>(`${fixturePath(scope)}/registration-removals/${encodeURIComponent(operationId)}`, options), scope, operationId);
}

export async function findFixtureRegistrationRemovalByRequest(scope: FixtureRemovalScope, clientRequestId: string, options?: ApiRequestOptions) {
  const value = await apiGet<unknown>(`${fixturePath(scope)}/registration-removals/by-request/${encodeURIComponent(clientRequestId)}`, options);
  return value === null ? null : parseView(value, scope);
}
