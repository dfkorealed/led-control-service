import { CanActivate, ExecutionContext, Injectable, NotFoundException } from "@nestjs/common";

@Injectable()
export class TestDataEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext) {
    if (process.env.VITE_TEST_DATA_TOOLS_ENABLED !== "true") {
      // Do this before auth so disabled tooling is indistinguishable from no route.
      throw new NotFoundException();
    }
    return true;
  }
}
