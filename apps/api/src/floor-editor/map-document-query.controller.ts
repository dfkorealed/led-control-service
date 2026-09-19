import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Query, StreamableFile, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { MapDocumentReader, MapQueryScope } from "./map-document-reader";

const refQuery = z.object({ generationId: z.string().min(1).max(128),
  revision: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().safe()) }).strict();
const changesQuery = refQuery.extend({ cursor: z.string().min(1).max(2048).optional() }).strict();
type Scope = { floorId: string; jobId?: string; stageId?: string };

@Controller(["floors/:floorId/map-document", "floors/:floorId/import-jobs/:jobId/map-document",
  "floors/:floorId/editor-stages/:stageId/map-document"])
@UseGuards(SessionAuthGuard)
export class MapDocumentQueryController {
  constructor(private readonly reader: MapDocumentReader) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async getDocument(@Param() scope: Scope, @CurrentUser() user: AuthenticatedUser) {
    const document = await this.reader.getDocument(user, scope.floorId, queryScope(scope));
    // Nest's null return produces an empty body, which is not valid JSON null.
    return document ?? new StreamableFile(Buffer.from("null"), { type: "application/json" });
  }

  @Get("manifest")
  @Header("Cache-Control", "private, no-store")
  getManifest(@Param() scope: Scope, @Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.reader.getManifest(user, scope.floorId, parseQuery(refQuery, query), queryScope(scope));
  }

  @Get("tiles/:assetId")
  @Header("Cache-Control", "private, no-store")
  async getTile(@Param() scope: Scope & { assetId: string }, @Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    const bytes = await this.reader.getTile(user, scope.floorId, parseQuery(refQuery, query), scope.assetId, queryScope(scope));
    return new StreamableFile(bytes, { type: "application/octet-stream", length: bytes.length });
  }

  @Post("elements")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  getElements(@Param() scope: Scope, @Query() query: unknown, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.reader.getElements(user, scope.floorId, parseQuery(refQuery, query), body, queryScope(scope));
  }

  @Post("selection")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  select(@Param() scope: Scope, @Query() query: unknown, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.reader.select(user, scope.floorId, parseQuery(refQuery, query), body, queryScope(scope));
  }

  @Get("changes")
  @Header("Cache-Control", "private, no-store")
  getChanges(@Param() scope: Scope, @Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    const { cursor, ...ref } = parseQuery(changesQuery, query);
    return this.reader.getChanges(user, scope.floorId, ref, cursor, queryScope(scope));
  }
}

function queryScope(scope: Scope): MapQueryScope | undefined {
  return scope.stageId === undefined ? scope.jobId : { stageId: scope.stageId };
}

function parseQuery<S extends z.ZodTypeAny>(schema: S, query: unknown): z.output<S> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) throw new BadRequestException("invalid map document query");
  return parsed.data;
}
